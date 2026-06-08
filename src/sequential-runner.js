import { fetchLogsFromJSONFile, filterAndSortLogs, filterOrchestratorSkippableLogs } from './services/log-fetcher.js';
import { ReplayOrchestrator } from './orchestrator.js';
import { AsyncReplayOrchestrator } from './async-buffer/async-orchestrator.js';
import { createMockController } from './mocks/index.js';
import { MOCK_CONFIG, SERVICE_MAP, RETRY_CONFIG, RETRY_TIMEOUT_OVERRIDES } from './config.js';
import { BatchLogFetcher } from './log-fetcher/index.js';
import { ArtReportGenerator } from './services/art-report-generator.js';
import { logger } from './utils/logger.js';
import { basename, dirname, extname, join } from 'path';
import { unlink } from 'fs/promises';
import { getOptionalRepeatPolicy } from './replay-special-cases.js';
import { findCorrespondingResponseEntry } from './services/response-matcher.js';

export async function runSequentialArt(orderList, config) {
  const maxJourneyTimeMs = config.MAX_JOURNEY_TIME_MS || 3 * 60 * 1000;
  const batchProcessingEnabled = config.ENABLE_BATCH_PROCESSING !== false;
  const requestedParallelOrders = batchProcessingEnabled
    ? Math.max(1, Math.min(config.PARALLEL_ORDERS || 10, 10))
    : 1;
  const parallelOrders = (!config.onOrchestratorReady || MOCK_CONFIG.enabled)
    ? 1
    : requestedParallelOrders;
  const reportGenerator = new ArtReportGenerator({
    reportPath: config.REPORT_PATH || 'report.json'
  });

  let shutdownRequested = false;

  const onShutdown = () => {
    if (shutdownRequested) return;
    shutdownRequested = true;
    console.log('\n\nShutdown requested, generating report...');
    reportGenerator.completeExecution(false);
    console.log(`Report saved to: ${config.REPORT_PATH || 'report.json'}`);
    process.exit(1);
  };

  process.on('SIGINT', onShutdown);
  process.on('SIGTERM', onShutdown);
  const cleanupHandlers = () => {
    process.off('SIGINT', onShutdown);
    process.off('SIGTERM', onShutdown);
  };

  if (requestedParallelOrders > 1 && parallelOrders === 1) {
    logger.warn('Parallel order execution requested but disabled for this run mode', {
      requestedParallelOrders,
      hasMultiplexer: !!config.onOrchestratorReady,
      mocksEnabled: MOCK_CONFIG.enabled
    });
  }

  console.log(`\n========================================`);
  console.log(parallelOrders > 1 ? 'Concurrent ART Runner' : 'Sequential ART Runner');
  console.log(`Total Orders: ${orderList.length}`);
  console.log(`Max Concurrent Orders: ${parallelOrders}`);
  console.log(`Max Journey Time: ${Math.round(maxJourneyTimeMs / 1000 / 60)} minutes`);
  console.log(`========================================\n`);

  reportGenerator.startExecution();

  // Start all S3 fetches concurrently in the background — returns a Map of Promises.
  // Workers await only their own order's promise, so replay and fetching overlap.
  console.log(`\n[PREFETCH] Starting background log fetch for all ${orderList.length} orders...`);
  const prefetchPromises = startPrefetchPromises(orderList, config);
  console.log(`[PREFETCH] Workers starting — fetching and replaying will run concurrently.\n`);

  const results = new Array(orderList.length);
  let nextOrderIndex = 0;

  const runOrderAtIndex = async (absoluteIndex) => {
    const { merchantId, orderId } = orderList[absoluteIndex];

    console.log(`\n========================================`);
    console.log(`Playing Order ${absoluteIndex + 1}/${orderList.length}`);
    console.log(`Merchant: ${merchantId}, Order: ${orderId}`);
    console.log(`========================================\n`);

    logger.info(`ART_PROGRESS: Playing order ${absoluteIndex + 1} out of ${orderList.length}`, {
      currentOrder: absoluteIndex + 1,
      totalOrders: orderList.length,
      activeSlots: parallelOrders,
      orderId,
      merchantId,
      phase: 'ORDER_START'
    });

    try {
      const orderResult = await processSingleOrder(
        merchantId,
        orderId,
        config,
        absoluteIndex + 1,
        orderList.length,
        maxJourneyTimeMs,
        reportGenerator,
        await (prefetchPromises?.get(orderId) ?? Promise.resolve(null))
      );

      const result = {
        orderIndex: absoluteIndex + 1,
        merchantId,
        orderId,
        success: orderResult.success,
        logsProcessed: orderResult.logCount,
        error: orderResult.error
      };

      if (!orderResult.success) {
        console.error(`Failed to process order ${orderId}: ${orderResult.error}`);
      } else {
        console.log(`\nOrder ${orderId} completed successfully`);
      }

      return { index: absoluteIndex, result };
    } catch (error) {
      console.error(`Exception processing order ${orderId}:`, error.message);
      reportGenerator.recordOrderError(orderId, error);

      return {
        index: absoluteIndex,
        result: {
          orderIndex: absoluteIndex + 1,
          merchantId,
          orderId,
          success: false,
          error: error.message
        }
      };
    }
  };

  const worker = async (workerId) => {
    while (true) {
      if (config.stopSignal?.requested) {
        logger.info('Stop requested, aborting remaining orders', { workerId });
        return;
      }

      if (nextOrderIndex >= orderList.length) {
        return;
      }

      const currentIndex = nextOrderIndex;
      nextOrderIndex += 1;

      logger.info('Dispatching order to worker slot', {
        workerId,
        orderIndex: currentIndex + 1,
        totalOrders: orderList.length
      });

      const { index, result } = await runOrderAtIndex(currentIndex);
      results[index] = result;
    }
  };

  const workerCount = Math.min(parallelOrders, orderList.length);
  await Promise.all(Array.from({ length: workerCount }, (_, index) => worker(index + 1)));

  cleanupHandlers();
  const finalizedResults = results.filter(Boolean);
  const overallSuccess = finalizedResults.every(r => r.success);
  reportGenerator.completeExecution(overallSuccess);

  console.log(`\n========================================`);
  console.log(parallelOrders > 1 ? 'Concurrent Processing Complete' : 'Sequential Processing Complete');
  console.log(`========================================`);
  const successful = finalizedResults.filter(r => r.success).length;
  const failed = finalizedResults.filter(r => !r.success).length;
  console.log(`Successful: ${successful}`);
  console.log(`Failed: ${failed}`);
  console.log(`Total: ${finalizedResults.length}`);
  console.log(`========================================\n`);

  return { success: failed === 0, results: finalizedResults };
}

/**
 * Fetches logs from S3 and runs the full filter pipeline for a single order.
 * Returns the final filtered logs array, or throws on failure.
 */
async function fetchAndFilterOrderLogs(merchantId, orderId, config, logsFilePath, filteredLogsPath, finalFilteredLogsPath) {
  const maxFetchAttempts = 5;
  const fetchRetryIntervalMs = 2000;
  let fetchResult = null;

  const preCachedLogs = await fetchLogsFromJSONFile(logsFilePath).catch(() => []);
  if (preCachedLogs.length > 0) {
    fetchResult = {
      success: true,
      stats: { totalLogs: preCachedLogs.length },
      allLogs: preCachedLogs
    };
  } else {
    for (let attempt = 1; attempt <= maxFetchAttempts; attempt++) {
      const fetcher = new BatchLogFetcher({
        sessionToken: config.SESSION_TOKEN,
        outputPath: logsFilePath,
        delayBetweenRequests: 500,
        maxRetries: 3
      });

      fetchResult = await fetcher.fetchLogsForOrders([{ merchantId, orderId }]);

      if (fetchResult.success && fetchResult.stats.totalLogs > 0) {
        break;
      }

      logger.warn(`[PREFETCH] Fetch attempt ${attempt}/${maxFetchAttempts} failed for order ${orderId}`, {
        attempt,
        maxFetchAttempts,
        totalLogs: fetchResult.stats?.totalLogs || 0,
        error: fetchResult.error || 'No logs found'
      });

      if (attempt < maxFetchAttempts) {
        await sleep(fetchRetryIntervalMs);
      }
    }
  }

  if (!fetchResult?.success || fetchResult.stats.totalLogs === 0) {
    throw new Error(`No logs found after ${maxFetchAttempts} attempts`);
  }

  const logs = await fetchLogsFromJSONFile(logsFilePath);
  if (logs.length === 0) throw new Error('No logs to process after fetch');

  const filteredLogs = await filterAndSortLogs(logs, filteredLogsPath);
  if (filteredLogs.length === 0) throw new Error('No logs remaining after filterAndSortLogs');

  const finalFilteredLogs = await filterOrchestratorSkippableLogs(filteredLogs, finalFilteredLogsPath);
  if (finalFilteredLogs.length === 0) throw new Error('No logs remaining after filterOrchestratorSkippableLogs');

  return finalFilteredLogs;
}

/**
 * Prefetch pipeline: fetches and filters S3 logs for ALL orders concurrently.
 * Returns a Map<orderId, { finalFilteredLogs, logsFilePath, filteredLogsPath, finalFilteredLogsPath }>
 * (or { error, logsFilePath, ... } on failure).
 * Workers consume pre-fetched data and skip the S3 wait entirely.
 */
function startPrefetchPromises(orderList, config) {
  // Returns Map<orderId, Promise<{finalFilteredLogs,...}|{error,...}>> immediately.
  // All fetches fire concurrently in the background. Each worker awaits its own.
  const promises = new Map();

  for (const { merchantId, orderId } of orderList) {
    // idx matches position in orderList, same as what processSingleOrder uses
    const orderIndex = orderList.findIndex(o => o.orderId === orderId) + 1;
    const logsFilePath          = getPerOrderFilePath(config.LOGS_FILE_PATH             || 'data/logs.json',              orderId, orderIndex, config);
    const filteredLogsPath      = getPerOrderFilePath(config.FILTERED_LOGS_PATH         || 'data/filtered-logs.json',      orderId, orderIndex, config);
    const finalFilteredLogsPath = getPerOrderFilePath(config.FINAL_FILTERED_LOGS_PATH   || 'data/final-filtered-logs.json', orderId, orderIndex, config);

    const p = fetchAndFilterOrderLogs(
      merchantId, orderId, config,
      logsFilePath, filteredLogsPath, finalFilteredLogsPath
    ).then(
      finalFilteredLogs => {
        console.log(`[PREFETCH] ✓ ${orderId}: ${finalFilteredLogs.length} logs ready`);
        return { finalFilteredLogs, logsFilePath, filteredLogsPath, finalFilteredLogsPath };
      },
      error => {
        console.log(`[PREFETCH] ✗ ${orderId}: ${error.message}`);
        logger.warn(`[PREFETCH] Failed for order ${orderId}`, { orderId, error: error.message });
        return { error: error.message, logsFilePath, filteredLogsPath, finalFilteredLogsPath };
      }
    );

    promises.set(orderId, p);
  }

  return promises;
}

async function processSingleOrder(merchantId, orderId, config, orderIndex, totalOrders, maxJourneyTimeMs, reportGenerator, prefetchedData = null) {
  let server = null;
  let orchestrator = null;
  let mocks = null;
  let progressInterval = null;
  const registrySessionId = getRegistrySessionId(config, orderId);
  const logsFilePath = prefetchedData?.logsFilePath ?? getPerOrderFilePath(config.LOGS_FILE_PATH || 'data/logs.json', orderId, orderIndex, config);
  const filteredLogsPath = prefetchedData?.filteredLogsPath ?? getPerOrderFilePath(config.FILTERED_LOGS_PATH || 'data/filtered-logs.json', orderId, orderIndex, config);
  const finalFilteredLogsPath = prefetchedData?.finalFilteredLogsPath ?? getPerOrderFilePath(config.FINAL_FILTERED_LOGS_PATH || 'data/final-filtered-logs.json', orderId, orderIndex, config);

  console.log(`Replay artifacts for ${orderId}:`);
  console.log(`  Raw logs: ${logsFilePath}`);
  console.log(`  Filtered logs: ${filteredLogsPath}`);
  console.log(`  Final filtered logs: ${finalFilteredLogsPath}`);

  const orderReport = reportGenerator.addOrder({
    orderId,
    merchantId,
    orderIndex,
    totalOrders
  });

  try {
    let finalFilteredLogs;

    if (prefetchedData?.finalFilteredLogs) {
      finalFilteredLogs = prefetchedData.finalFilteredLogs;
      logger.info(`ART_PROGRESS: Order ${orderIndex}/${totalOrders} - Using pre-fetched logs`, {
        orderId,
        orderIndex,
        totalOrders,
        logCount: finalFilteredLogs.length,
        phase: 'PREFETCH_HIT'
      });
      console.log(`[PREFETCH] Using ${finalFilteredLogs.length} pre-fetched logs for order ${orderId}`);
    } else {
      if (prefetchedData?.error) {
        logger.warn(`[PREFETCH] Pre-fetch failed for order ${orderId}, falling back to inline fetch`, {
          orderId,
          error: prefetchedData.error
        });
      }

      logger.info(`ART_PROGRESS: Order ${orderIndex}/${totalOrders} - Step 1: Fetching logs`, {
        orderId,
        orderIndex,
        totalOrders,
        phase: 'FETCH_LOGS'
      });

      let fetchResult = null;
      const maxFetchAttempts = 5;
      const fetchRetryIntervalMs = 2000;

      const preCachedLogs = await fetchLogsFromJSONFile(logsFilePath).catch(() => []);
      if (preCachedLogs.length > 0) {
        console.log(`  Using pre-cached logs for order ${orderId} (${preCachedLogs.length} entries)`);
        fetchResult = {
          success: true,
          stats: { totalLogs: preCachedLogs.length },
          allLogs: preCachedLogs
        };
      } else {
        for (let attempt = 1; attempt <= maxFetchAttempts; attempt++) {
          const fetcher = new BatchLogFetcher({
            sessionToken: config.SESSION_TOKEN,
            outputPath: logsFilePath,
            delayBetweenRequests: 500,
            maxRetries: 3
          });

          fetchResult = await fetcher.fetchLogsForOrders([{ merchantId, orderId }]);

          if (fetchResult.success && fetchResult.stats.totalLogs > 0) {
            break;
          }

          logger.warn(`Log fetch attempt ${attempt}/${maxFetchAttempts} failed for order ${orderId}`, {
            attempt,
            maxFetchAttempts,
            totalLogs: fetchResult.stats?.totalLogs || 0,
            error: fetchResult.error || 'No logs found'
          });

          if (attempt < maxFetchAttempts) {
            console.log(`  Log fetch attempt ${attempt}/${maxFetchAttempts} returned 0 logs, retrying in 2s...`);
            await new Promise(resolve => setTimeout(resolve, fetchRetryIntervalMs));
          }
        }
      }

      if (!fetchResult.success || fetchResult.stats.totalLogs === 0) {
        const error = `No logs found after ${maxFetchAttempts} attempts`;
        console.log(`  Failed to fetch logs for order ${orderId} after ${maxFetchAttempts} attempts, skipping.`);
        reportGenerator.finalizeOrder(orderId, {
          success: false,
          stopReason: error,
          logsProcessed: 0
        });
        return {
          success: false,
          logCount: 0,
          error
        };
      }

      console.log(`Fetched ${fetchResult.stats.totalLogs} logs for order ${orderId} (attempt ${fetchResult.stats.totalLogs > 0 ? 'succeeded' : 'exhausted'})`);

      logger.info(`ART_PROGRESS: Order ${orderIndex}/${totalOrders} - Step 2: Loading and filtering logs`, {
        orderId,
        orderIndex,
        totalOrders,
        phase: 'FILTER_LOGS'
      });

      const logs = await fetchLogsFromJSONFile(logsFilePath);

      if (logs.length === 0) {
        reportGenerator.finalizeOrder(orderId, {
          success: false,
          stopReason: 'No logs to process',
          logsProcessed: 0
        });
        return { success: false, logCount: 0, error: 'No logs to process' };
      }

      console.log(`Loaded ${logs.length} logs`);

      const filteredLogs = await filterAndSortLogs(logs, filteredLogsPath);

      if (filteredLogs.length === 0) {
        reportGenerator.finalizeOrder(orderId, {
          success: false,
          stopReason: 'No logs after filtering',
          logsProcessed: 0
        });
        return { success: false, logCount: 0, error: 'No logs after filtering' };
      }

      finalFilteredLogs = await filterOrchestratorSkippableLogs(filteredLogs, finalFilteredLogsPath);

      if (finalFilteredLogs.length === 0) {
        reportGenerator.finalizeOrder(orderId, {
          success: false,
          stopReason: 'No logs after second filtering',
          logsProcessed: 0
        });
        return { success: false, logCount: 0, error: 'No logs after second filtering' };
      }
    }

    orderReport.logsTotal = finalFilteredLogs.length;
    console.log(`Ready to replay ${finalFilteredLogs.length} unique logs`);

    const replayLenderOrgIds = getReplayLenderOrgIds(finalFilteredLogs);
    const skippedLenderOrgIds = (config.SKIP_LENDER_ORG_IDS || []).filter(lenderOrgId =>
      replayLenderOrgIds.includes(lenderOrgId)
    );

    if (skippedLenderOrgIds.length > 0) {
      const skipReason = `Skipped by config: replay contains lenderOrgId(s) ${skippedLenderOrgIds.join(', ')}`;
      logger.warn(`ART_PROGRESS: Order ${orderIndex}/${totalOrders} - ${skipReason}`, {
        orderId,
        orderIndex,
        totalOrders,
        replayLenderOrgIds,
        skippedLenderOrgIds,
        phase: 'ORDER_SKIPPED'
      });

      reportGenerator.finalizeOrder(orderId, {
        success: true,
        skipped: true,
        stopReason: skipReason,
        logsProcessed: 0,
        artResults: {
          passed: 0,
          failed: 0,
          processedLogs: [],
          payloadComparisons: []
        }
      });

      return {
        success: true,
        skipped: true,
        logCount: 0
      };
    }

    if (MOCK_CONFIG.enabled) {
      throw new Error('MOCK_CONFIG.enabled is not supported in unix-socket-only ART mode.');
    }

    logger.info(`ART_PROGRESS: Order ${orderIndex}/${totalOrders} - Step 3: Starting ART replay`, {
      orderId,
      orderIndex,
      totalOrders,
      totalLogs: finalFilteredLogs.length,
      phase: 'START_REPLAY'
    });
    
    const OrchestratorClass = config.USE_ASYNC_ORCHESTRATOR ? AsyncReplayOrchestrator : ReplayOrchestrator;
    orchestrator = new OrchestratorClass(finalFilteredLogs, {
      timeoutMs: config.TIMEOUT_MS,
      orderId,
      orderIndex,
      totalOrders,
      reportGenerator,
      registrySessionId,
      onLoanApplicationId: config.onLoanApplicationId
    });

    if (config.onOrchestratorReady) {
      config.onOrchestratorReady(orchestrator, orderId, registrySessionId);
      const loanApplicationIds = [...new Set(finalFilteredLogs
        .map(l => l.loan_application_id || l.loanApplicationId)
        .filter(Boolean))];
      for (const laId of loanApplicationIds) {
        config.onLoanApplicationId?.(laId, orderId, registrySessionId);
      }
    } else {
      throw new Error('Legacy per-order TCP server mode is no longer supported. Use the unix-socket multiplexer flow.');
    }

    logger.info(`ART_PROGRESS: Order ${orderIndex}/${totalOrders} - Step 4: Running ART replay`, {
      orderId,
      orderIndex,
      totalOrders,
      phase: 'RUNNING_REPLAY'
    });
    
    await orchestrator.start();

    progressInterval = setInterval(() => {
      if (!orchestrator || !orchestrator.isRunning) {
        clearInterval(progressInterval);
        return;
      }

      const progress = orchestrator.validator?.getProgress();
      const currentEntry = orchestrator.validator?.getCurrentEntry();
      
      if (progress && currentEntry) {
        logger.info(`ART_PROGRESS: Order ${orderIndex}/${totalOrders} - Processing ${progress.progress} - Current: ${currentEntry.logTag || 'N/A'}`, {
          orderId,
          orderIndex,
          totalOrders,
          currentLogTag: currentEntry.logTag,
          currentLogIndex: currentEntry.index,
          progressPercent: progress.progress,
          processed: progress.processed,
          remaining: progress.remaining,
          total: progress.total,
          phase: 'IN_PROGRESS'
        });

        reportGenerator.updateOrderProgress(orderId, {
          logTag: currentEntry.logTag,
          logIndex: currentEntry.index,
          logsProcessed: progress.processed,
          timeline: {
            logTag: currentEntry.logTag,
            progress: progress.progress,
            action: 'processing'
          }
        });
      }
    }, 5000);

    logger.info(`ART_PROGRESS: Order ${orderIndex}/${totalOrders} - Step 5: Waiting for completion (max ${Math.round(maxJourneyTimeMs / 1000 / 60)} minutes)`, {
      orderId,
      orderIndex,
      totalOrders,
      maxJourneyTimeMinutes: Math.round(maxJourneyTimeMs / 1000 / 60),
      phase: 'WAITING_COMPLETION'
    });
    
    const completionResult = await waitForCompletionWithTimeout(
      orchestrator,
      maxJourneyTimeMs,
      orderId,
      orderIndex,
      totalOrders,
      reportGenerator,
      config.stopSignal
    );

    if (progressInterval) {
      clearInterval(progressInterval);
    }

    const artResults = orchestrator.getResults();
    
    console.log(`\nOrder ${orderId} Results:`);
    console.log(`  Passed: ${artResults.passed}`);
    console.log(`  Failed: ${artResults.failed}`);
    console.log(`  Total: ${artResults.processedLogs?.length || 0}`);

    if (completionResult.timedOut) {
      const currentEntry = orchestrator.validator?.getCurrentEntry();
      const lastMatchTimeout = orchestrator.bufferManager?.getLastMatchTimeout?.() || null;
      const pendingWaiters = orchestrator.bufferManager?.getPendingRequestWaiters?.() || [];
      const primaryPendingWaiter = pendingWaiters[0] || null;
      const timeoutReason = lastMatchTimeout?.expected
        ? `Timed out waiting for matching request ${lastMatchTimeout.expected}`
        : primaryPendingWaiter?.expected
          ? `Timed out while waiting on pending request ${primaryPendingWaiter.expected}`
        : `Timeout after ${Math.round(maxJourneyTimeMs / 1000 / 60)} minutes`;

      reportGenerator.markOrderStuck(orderId, {
        logTag: currentEntry?.logTag || 'unknown',
        logIndex: currentEntry?.index || 0,
        reason: timeoutReason
      });

      printBufferDebugInfo(orchestrator, orderId);
    }

    // failedBufferRequests comes from httpClient.failedRequests (non-blocking-http.js)
    // and has the properly formatted errorMessage with the actual API error_message field.
    // Fall back to the orchestrator's failureReason which is set in fail().
    const failedBufferRequests = artResults.failedBufferRequests || [];
    const latestBufferFailure = failedBufferRequests[failedBufferRequests.length - 1];
    const apiErrorMessage = latestBufferFailure?.errorMessage
      || (completionResult.failed ? completionResult.error : null);

    const stopReason = completionResult.stopped
      ? 'Stopped by user'
      : completionResult.failed
        ? `API Failure: ${apiErrorMessage || completionResult.error || 'Unknown API error'}`
        : completionResult.timedOut
          ? `Timeout: ${orchestrator.bufferManager?.getLastMatchTimeout?.()?.expected
            ? `Timed out waiting for matching request ${orchestrator.bufferManager.getLastMatchTimeout().expected}`
            : orchestrator.bufferManager?.getPendingRequestWaiters?.()?.[0]?.expected
              ? `Timed out while waiting on pending request ${orchestrator.bufferManager.getPendingRequestWaiters()[0].expected}`
            : `Max journey time of ${Math.round(maxJourneyTimeMs / 1000 / 60)} minutes exceeded`}`
          : (artResults.failed > 0 ? `${artResults.failed} assertions failed` : 'Completed successfully');

    reportGenerator.finalizeOrder(orderId, {
      success: !completionResult.timedOut && !completionResult.stopped && !completionResult.failed && artResults.failed === 0,
      stopReason,
      errorMessage: completionResult.failed ? apiErrorMessage : null,
      logsProcessed: artResults.processedLogs?.length || 0,
      artResults
    });

    await orchestrator.stop();

    if (server) {
      await new Promise(resolve => server.close(resolve));
    }

    if (config.onOrchestratorReady) {
      config.registry?.unregister(registrySessionId);
    }

    if (mocks) {
      await mocks.stop();
    }

    return {
      success: !completionResult.timedOut && artResults.failed === 0,
      logCount: finalFilteredLogs.length,
      artResults,
      error: !completionResult.timedOut && artResults.failed === 0
        ? null
        : (apiErrorMessage || stopReason || artResults.failureReason || 'ART replay failed')
    };

  } catch (error) {
    if (progressInterval) {
      clearInterval(progressInterval);
    }
    
    console.error(`Error processing order ${orderId}:`, error.message);
    reportGenerator.recordOrderError(orderId, {
      message: error.message,
      stack: error.stack,
      step: 'orchestrator_execution'
    });
    
    if (orchestrator) await orchestrator.stop();
    if (server) await new Promise(resolve => server.close(resolve));
    if (config.onOrchestratorReady) {
      config.registry?.unregister(registrySessionId);
    }
    if (mocks) await mocks.stop();

    const currentEntry = orchestrator?.validator?.getCurrentEntry();
    reportGenerator.finalizeOrder(orderId, {
      success: false,
      stopReason: error.message,
      logsProcessed: 0,
      stuckAt: currentEntry ? {
        logTag: currentEntry.logTag,
        logIndex: currentEntry.index
      } : null
    });

    return {
      success: false,
      logCount: 0,
      error: error.message
    };
  } finally {
    if (shouldCleanupOrderTempFiles(config)) {
      await cleanupOrderTempFiles(orderId, orderIndex, [
        logsFilePath,
        filteredLogsPath,
        finalFilteredLogsPath
      ]);
    }
  }
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function shouldCleanupOrderTempFiles(config) {
  return config.KEEP_ORDER_TEMP_FILES !== true;
}

function getRegistrySessionId(config, orderId) {
  if (typeof config.getRegistrySessionId === 'function') {
    return config.getRegistrySessionId(orderId);
  }

  return config.sessionId || orderId;
}

async function cleanupOrderTempFiles(orderId, orderIndex, filePaths) {
  const deletedFiles = [];

  for (const filePath of filePaths) {
    try {
      await unlink(filePath);
      deletedFiles.push(filePath);
    } catch (error) {
      if (error.code !== 'ENOENT') {
        logger.warn('Failed to delete order temp file', {
          orderId,
          orderIndex,
          filePath,
          error: error.message
        });
      }
    }
  }

  if (deletedFiles.length > 0) {
    logger.info('Deleted order temp files', {
      orderId,
      orderIndex,
      deletedFiles
    });
  }
}

function getPerOrderFilePath(basePath, orderId, orderIndex, config) {
  if (!config.onOrchestratorReady) {
    return basePath;
  }


  const extension = extname(basePath);
  const name = basename(basePath, extension);
  const safeOrderId = String(orderId).replace(/[^a-zA-Z0-9_-]/g, '_');
  return join(dirname(basePath), `${name}-${orderIndex}-${safeOrderId}${extension}`);
}

function sharesReplayContext(leftEntry, rightEntry) {
  if (!leftEntry || !rightEntry) {
    return false;
  }

  if (leftEntry.orderId && rightEntry.orderId && leftEntry.orderId !== rightEntry.orderId) {
    return false;
  }

  if (leftEntry.loanApplicationId && rightEntry.loanApplicationId && leftEntry.loanApplicationId !== rightEntry.loanApplicationId) {
    return false;
  }

  if (leftEntry.lenderOrgId && rightEntry.lenderOrgId && leftEntry.lenderOrgId !== rightEntry.lenderOrgId) {
    return false;
  }

  return true;
}

function collectLenderOrgIds(value, acc = new Set()) {
  if (value === null || value === undefined) {
    return acc;
  }

  if (Array.isArray(value)) {
    for (const item of value) {
      collectLenderOrgIds(item, acc);
    }
    return acc;
  }

  if (typeof value !== 'object') {
    return acc;
  }

  for (const [key, nestedValue] of Object.entries(value)) {
    if ((key === 'lenderOrgId' || key === 'lender_org_id') && typeof nestedValue === 'string' && nestedValue.trim()) {
      acc.add(nestedValue.trim());
    }
    collectLenderOrgIds(nestedValue, acc);
  }

  return acc;
}

function getReplayLenderOrgIds(finalFilteredLogs) {
  const lenderOrgIds = new Set();

  for (const rawLog of finalFilteredLogs || []) {
    const message = rawLog?.message || {};
    if (message.log_tag !== 'LSP-FetchOfferRequest_REQUEST') {
      continue;
    }

    collectLenderOrgIds(message.trace_request, lenderOrgIds);

    if (typeof message.lender_org_id === 'string' && message.lender_org_id.trim()) {
      lenderOrgIds.add(message.lender_org_id.trim());
    }
  }

  return [...lenderOrgIds];
}

function hasProcessedBranchAdvance(orchestrator, currentEntry, optionalRepeatPolicy) {
  if (!optionalRepeatPolicy.advanceWhenSeenLogTags?.length) {
    return false;
  }

  return orchestrator.validator.entries.some((entry, index) =>
    orchestrator.validator.processedIndices.has(index) &&
    index > currentEntry.index &&
    entry.isRequest &&
    optionalRepeatPolicy.advanceWhenSeenLogTags.includes(entry.logTag) &&
    sharesReplayContext(currentEntry, entry)
  );
}

function hasObservedBranchAdvance(orchestrator, currentEntry, optionalRepeatPolicy) {
  if (optionalRepeatPolicy.allowObservedBranchAdvance === false) {
    return false;
  }

  if (!optionalRepeatPolicy.advanceWhenSeenLogTags?.length) {
    return false;
  }

  const observedRequests = orchestrator.observedIncomingRequests || [];

  return observedRequests.some(entry =>
    optionalRepeatPolicy.advanceWhenSeenLogTags.includes(entry.logTag) &&
    sharesReplayContext(currentEntry, entry)
  );
}

function getPayloadValueAtPath(payload, payloadPath) {
  if (!payload || !payloadPath) {
    return undefined;
  }

  return payloadPath.split('.').reduce((current, segment) => {
    if (current === null || current === undefined) {
      return undefined;
    }

    return current[segment];
  }, payload);
}

function matchesPriorProcessedEntryCondition(entry, condition) {
  if (!condition || entry?.logTag !== condition.logTag) {
    return false;
  }

  if (!condition.payloadPath) {
    return true;
  }

  return getPayloadValueAtPath(entry.payload, condition.payloadPath) === condition.equals;
}

function matchesObservedProcessedResponseCondition(entry, condition) {
  if (!condition || entry?.logTag !== condition.logTag) {
    return false;
  }

  if (!condition.payloadPath) {
    return true;
  }

  return getPayloadValueAtPath(entry.payload, condition.payloadPath) === condition.equals;
}

function hasPriorProcessedAlternate(orchestrator, currentEntry, optionalRepeatPolicy) {
  const hasTagBasedRules = optionalRepeatPolicy.skipWhenPriorProcessedLogTags?.length;
  const hasConditionalRules = optionalRepeatPolicy.skipWhenPriorProcessedEntries?.length;

  if (!hasTagBasedRules && !hasConditionalRules) {
    return false;
  }

  const observedProcessedResponses = orchestrator.observedProcessedResponses || [];
  const matchingObservedResponse = observedProcessedResponses.some(entry =>
    optionalRepeatPolicy.skipWhenPriorProcessedEntries.some(condition =>
      matchesObservedProcessedResponseCondition(entry, condition)
    ) &&
    sharesReplayContext(currentEntry, entry)
  );

  if (matchingObservedResponse) {
    return true;
  }

  return orchestrator.validator.entries.some((entry, index) =>
    orchestrator.validator.processedIndices.has(index) &&
    index < currentEntry.index &&
    (
      optionalRepeatPolicy.skipWhenPriorProcessedLogTags.includes(entry.logTag) ||
      optionalRepeatPolicy.skipWhenPriorProcessedEntries.some(condition =>
        matchesPriorProcessedEntryCondition(entry, condition)
      )
    ) &&
    sharesReplayContext(currentEntry, entry)
  );
}

function maybeSkipOptionalRepeatedEntry(orchestrator, currentEntry, orderId, orderIndex, totalOrders, stuckDurationMs) {
  const optionalRepeatPolicy = getOptionalRepeatPolicy(orchestrator?.config, currentEntry);

  if (!optionalRepeatPolicy) {
    return false;
  }

  if (stuckDurationMs < optionalRepeatPolicy.optionalAfterSeconds * 1000) {
    return false;
  }

  const priorReplayOccurrences = orchestrator.validator.entries.filter((entry) =>
    entry.isRequest &&
    entry.index < currentEntry.index &&
    entry.source === currentEntry.source &&
    entry.destination === currentEntry.destination &&
    entry.logTag === currentEntry.logTag &&
    sharesReplayContext(currentEntry, entry)
  );

  const processedSameTagCount = priorReplayOccurrences.filter(entry =>
    orchestrator.validator.processedIndices.has(entry.index)
  ).length;

  const branchAdvanced = hasProcessedBranchAdvance(orchestrator, currentEntry, optionalRepeatPolicy);
  const branchAdvancedObserved = hasObservedBranchAdvance(orchestrator, currentEntry, optionalRepeatPolicy);
  const priorAlternateProcessed = hasPriorProcessedAlternate(orchestrator, currentEntry, optionalRepeatPolicy);
  const hasAnyAdvanceSignal = branchAdvanced || branchAdvancedObserved || priorAlternateProcessed;

  if (optionalRepeatPolicy.requirePriorProcessedOccurrence && priorReplayOccurrences.length < 1) {
    return false;
  }

  if (optionalRepeatPolicy.requireBranchAdvance && !hasAnyAdvanceSignal) {
    return false;
  }

  if (
    optionalRepeatPolicy.requirePriorProcessedOccurrence &&
    processedSameTagCount < 1 &&
    !hasAnyAdvanceSignal
  ) {
    return false;
  }

  if (
    !optionalRepeatPolicy.requirePriorProcessedOccurrence &&
    !hasAnyAdvanceSignal
  ) {
    return false;
  }

  const responseEntry = findCorrespondingResponseEntry(orchestrator.validator.entries, currentEntry, {
    searchAll: false,
    processedIndices: orchestrator.validator.processedIndices
  });

  logger.warn(
    `ART_PROGRESS: Order ${orderIndex}/${totalOrders} - Auto-skipping optional repeated entry after ${optionalRepeatPolicy.optionalAfterSeconds}s - Current: ${currentEntry.logTag}`,
    {
      orderId,
      orderIndex,
      totalOrders,
      currentLogTag: currentEntry.logTag,
      currentLogIndex: currentEntry.index,
      priorReplayOccurrenceCount: priorReplayOccurrences.length,
      processedSameTagCount,
      branchAdvanced,
      branchAdvancedObserved,
      priorAlternateProcessed,
      branchAdvanceLogTags: optionalRepeatPolicy.advanceWhenSeenLogTags,
      priorProcessedAlternateLogTags: optionalRepeatPolicy.skipWhenPriorProcessedLogTags,
      skippedResponseIndex: responseEntry?.index ?? null,
      optionalAfterSeconds: optionalRepeatPolicy.optionalAfterSeconds,
      phase: 'OPTIONAL_REPEAT_SKIP'
    }
  );

  if (typeof orchestrator.bufferManager?.skipWaiter === 'function') {
    orchestrator.bufferManager.skipWaiter(currentEntry);
  }

  orchestrator.validator.markProcessed(currentEntry);
  if (responseEntry) {
    orchestrator.validator.markProcessed(responseEntry);
  }

  return true;
}

async function waitForCompletionWithTimeout(orchestrator, timeoutMs, orderId, orderIndex, totalOrders, reportGenerator, stopSignal) {
  const startTime = Date.now();
  let lastLoggedMinute = 0;
  const { retryIntervalMs, maxRetrySeconds } = RETRY_CONFIG;

  const getMaxRetrySeconds = (logTag) =>
    RETRY_TIMEOUT_OVERRIDES[logTag] || maxRetrySeconds;

  let stuckEntryIndex = null;
  let stuckSince = null;

  while (Date.now() - startTime < timeoutMs) {
    if (stopSignal?.requested) {
      const currentEntry = orchestrator.validator?.getCurrentEntry();
      logger.info(`ART_PROGRESS: Order ${orderIndex}/${totalOrders} - Stop requested by user - Current: ${currentEntry?.logTag || 'N/A'}`, {
        orderId,
        orderIndex,
        totalOrders,
        currentLogTag: currentEntry?.logTag,
        currentLogIndex: currentEntry?.index,
        phase: 'USER_STOP'
      });
      return { timedOut: false, stopped: true };
    }

    if (orchestrator.isFailed?.()) {
      const reason = orchestrator.failureReason;
      logger.warn(`ART_PROGRESS: Order ${orderIndex}/${totalOrders} - API failure detected: ${reason}`, {
        orderId,
        orderIndex,
        totalOrders,
        failureReason: reason,
        phase: 'API_FAILURE'
      });
      return { timedOut: false, failed: true, error: reason };
    }

    if (orchestrator.isComplete()) {
      return { timedOut: false };
    }

    const currentEntry = orchestrator.validator?.getCurrentEntry();
    const currentIndex = currentEntry?.index ?? null;

    // Track how long we've been stuck on the same entry
    if (currentIndex !== null && currentIndex === stuckEntryIndex) {
      const currentMaxRetrySeconds = getMaxRetrySeconds(currentEntry?.logTag);
      const currentMaxRetryMs = currentMaxRetrySeconds * 1000;
      const stuckDurationMs = Date.now() - stuckSince;

      if (maybeSkipOptionalRepeatedEntry(orchestrator, currentEntry, orderId, orderIndex, totalOrders, stuckDurationMs)) {
        stuckEntryIndex = null;
        stuckSince = null;
        continue;
      }

      if (stuckDurationMs >= currentMaxRetryMs) {
        logger.warn(`ART_PROGRESS: Order ${orderIndex}/${totalOrders} - Entry stuck for ${currentMaxRetrySeconds}s, giving up - Stuck at: ${currentEntry?.logTag || 'unknown'}`, {
          orderId,
          orderIndex,
          totalOrders,
          currentLogTag: currentEntry?.logTag,
          currentLogIndex: currentIndex,
          maxRetrySeconds: currentMaxRetrySeconds,
          retryIntervalMs,
          phase: 'ENTRY_TIMEOUT'
        });
        return { timedOut: true, stuckEntry: currentEntry };
      }
    } else {
      stuckEntryIndex = currentIndex;
      stuckSince = Date.now();
    }

    const elapsedMs = Date.now() - startTime;
    const elapsedMinutes = Math.floor(elapsedMs / 60000);

    if (elapsedMinutes > lastLoggedMinute) {
      lastLoggedMinute = elapsedMinutes;
      const remainingMinutes = Math.ceil((timeoutMs - elapsedMs) / 60000);

      logger.info(`ART_PROGRESS: Order ${orderIndex}/${totalOrders} - Running for ${elapsedMinutes} minute(s), ${remainingMinutes} minute(s) remaining - Current: ${currentEntry?.logTag || 'N/A'}`, {
        orderId,
        orderIndex,
        totalOrders,
        elapsedMinutes,
        remainingMinutes,
        currentLogTag: currentEntry?.logTag,
        currentLogIndex: currentEntry?.index,
        phase: 'TIME_CHECK'
      });
    }

    await sleep(retryIntervalMs);
  }

  const currentEntry = orchestrator.validator?.getCurrentEntry();
  logger.warn(`ART_PROGRESS: Order ${orderIndex}/${totalOrders} - TIMEOUT after ${Math.round(timeoutMs / 1000 / 60)} minutes - Stuck at: ${currentEntry?.logTag || 'unknown'}`, {
    orderId,
    orderIndex,
    totalOrders,
    currentLogTag: currentEntry?.logTag,
    currentLogIndex: currentEntry?.index,
    phase: 'TIMEOUT'
  });

  return { timedOut: true };
}

function printBufferDebugInfo(orchestrator, orderId) {
  console.log(`\n================================================================================`);
  console.log(`BUFFER DEBUG INFO FOR ORDER ${orderId} (Timed Out)`);
  console.log(`================================================================================\n`);
  
  try {
    console.log(`📤 SENT REQUESTS & RESPONSES:\n`);
    
    if (orchestrator.requestRouter?.outgoingRequests?.size) {
      console.log(`Outgoing Requests (${orchestrator.requestRouter.outgoingRequests.size}):`);
      for (const [id, req] of orchestrator.requestRouter.outgoingRequests) {
        console.log(`  Request ID: ${id}`);
        console.log(`    URL: ${req.url || 'N/A'}`);
        console.log(`    Method: ${req.method || 'N/A'}`);
        console.log(`    Body Preview: ${JSON.stringify(req.body || {}).substring(0, 200)}...`);
        if (req.response) {
          console.log(`    Response: ${JSON.stringify(req.response).substring(0, 200)}...`);
        }
      }
    } else {
      console.log(`  No outgoing requests recorded.`);
    }
    
    console.log(`\n📦 ASYNC BUFFER STATE:\n`);
    
    if (orchestrator.asyncProcessor?.httpClient) {
      const httpClient = orchestrator.asyncProcessor.httpClient;
      
      console.log(`Active Buffer Queue Size: ${httpClient.activeQueue?.size || 0}`);
      console.log(`Completed Requests: ${httpClient.completedQueue?.length || 0}`);
      console.log(`Failed Requests: ${httpClient.failedQueue?.length || 0}`);
      
      if (httpClient.completedQueue?.length > 0) {
        console.log(`\nCompleted Buffer Requests:`);
        httpClient.completedQueue.forEach((item, idx) => {
          console.log(`  [${idx}] ID: ${item.id}`);
          console.log(`      URL: ${item.url}`);
          console.log(`      Status: ${item.response?.status}`);
          console.log(`      Has Response: ${!!item.response}`);
        });
      }
      
      if (httpClient.failedQueue?.length > 0) {
        console.log(`\nFailed Buffer Requests:`);
        httpClient.failedQueue.forEach((item, idx) => {
          console.log(`  [${idx}] ID: ${item.id}`);
          console.log(`      URL: ${item.url}`);
          console.log(`      Error: ${item.error}`);
          console.log(`      Timestamp: ${item.timestamp}`);
        });
      }
    } else {
      console.log(`  No async processor or HTTP client available.`);
    }
    
    console.log(`\n📨 INCOMING REQUESTS IN FLIGHT:\n`);
    
    if (orchestrator.waitingIncomingRequests?.size) {
      console.log(`Waiting Incoming Requests (${orchestrator.waitingIncomingRequests.size}):`);
      for (const [key, req] of orchestrator.waitingIncomingRequests) {
        console.log(`  Key: ${key}`);
        console.log(`    Log Tag: ${req.logTag || 'N/A'}`);
        console.log(`    Resolved: ${req.resolved}`);
      }
    } else {
      console.log(`  No incoming requests waiting.`);
    }
    
    console.log(`\n⏳ OUTGOING REQUESTS WAITING:\n`);
    
    if (orchestrator.waitingOutgoingRequests?.size) {
      console.log(`Waiting Outgoing Requests (${orchestrator.waitingOutgoingRequests.size}):`);
      for (const [key, req] of orchestrator.waitingOutgoingRequests) {
        console.log(`  Key: ${key}`);
        console.log(`    Log Tag: ${req.logTag || 'N/A'}`);
        console.log(`    Timestamp: ${req.timestamp}`);
      }
    } else {
      console.log(`  No outgoing requests waiting.`);
    }
    
    console.log(`\n🗂️  RESPONSE BUFFER:\n`);
    
    if (orchestrator.responseBuffer?.size) {
      console.log(`Buffered Responses (${orchestrator.responseBuffer.size}):`);
      for (const [key, resp] of orchestrator.responseBuffer) {
        console.log(`  Key: ${key}`);
        console.log(`    Status: ${resp.status}`);
        console.log(`    Has Data: ${!!resp.data}`);
        console.log(`    Timestamp: ${resp.timestamp || 'N/A'}`);
      }
    } else {
      console.log(`  No buffered responses.`);
    }
    
    console.log(`\n❌ BUFFER FAILURES RECORDED:\n`);
    
    if (orchestrator.reportGenerator?.getBufferFailuresForOrder) {
      const failures = orchestrator.reportGenerator.getBufferFailuresForOrder(orderId);
      console.log(`Failures for this order (${failures.length}):`);
      if (failures.length > 0) {
        failures.forEach((failure, idx) => {
          console.log(`  [${idx}] Type: ${failure.type}`);
          console.log(`      URL: ${failure.url || 'N/A'}`);
          console.log(`      Error: ${failure.error || 'N/A'}`);
          console.log(`      Timestamp: ${failure.timestamp || 'N/A'}`);
          console.log(`      Payload Preview: ${JSON.stringify(failure.payload || {}).substring(0, 150)}...`);
        });
      } else {
        console.log(`  No failures recorded.`);
      }
    } else {
      console.log(`  reportGenerator.getBufferFailuresForOrder not available.`);
    }
    
  } catch (error) {
    console.log(`\n⚠️  Error printing buffer debug info: ${error.message}`);
    console.log(error.stack);
  }
  
  console.log(`\n================================================================================`);
  console.log(`END OF BUFFER DEBUG INFO`);
  console.log(`================================================================================\n`);
}

export default runSequentialArt;
