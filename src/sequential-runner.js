import { fetchLogsFromJSONFile, filterAndSortLogs, filterOrchestratorSkippableLogs } from './services/log-fetcher.js';
import { ReplayOrchestrator } from './orchestrator.js';
import { AsyncReplayOrchestrator } from './async-buffer/async-orchestrator.js';
import { createServer } from './server.js';
import { createMockController } from './mocks/index.js';
import { MOCK_CONFIG, SERVICE_MAP, RETRY_CONFIG, RETRY_TIMEOUT_OVERRIDES } from './config.js';
import { BatchLogFetcher } from './log-fetcher/index.js';
import { ArtReportGenerator } from './services/art-report-generator.js';
import { logger } from './utils/logger.js';

export async function runSequentialArt(orderList, config) {
  const maxJourneyTimeMs = config.MAX_JOURNEY_TIME_MS || 3 * 60 * 1000;
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
  // Clean up handlers when done so they don't accumulate across multiple runs
  const cleanupHandlers = () => {
    process.off('SIGINT', onShutdown);
    process.off('SIGTERM', onShutdown);
  };

  console.log(`\n========================================`);
  console.log(`Sequential ART Runner`);
  console.log(`Total Orders: ${orderList.length}`);
  console.log(`Max Journey Time: ${Math.round(maxJourneyTimeMs / 1000 / 60)} minutes`);
  console.log(`========================================\n`);

  reportGenerator.startExecution();
  const results = [];

  for (let i = 0; i < orderList.length; i++) {
    if (config.stopSignal?.requested) {
      logger.info('Stop requested, aborting remaining orders');
      break;
    }

    const { merchantId, orderId } = orderList[i];
    
    console.log(`\n========================================`);
    console.log(`Playing Order ${i + 1}/${orderList.length}`);
    console.log(`Merchant: ${merchantId}, Order: ${orderId}`);
    console.log(`========================================\n`);

    logger.info(`ART_PROGRESS: Playing order ${i + 1} out of ${orderList.length}`, {
      currentOrder: i + 1,
      totalOrders: orderList.length,
      orderId,
      merchantId,
      phase: 'ORDER_START'
    });

    try {
      const orderResult = await processSingleOrder(
        merchantId, 
        orderId, 
        config, 
        i + 1, 
        orderList.length,
        maxJourneyTimeMs,
        reportGenerator
      );
      
      results.push({
        orderIndex: i + 1,
        merchantId,
        orderId,
        success: orderResult.success,
        logsProcessed: orderResult.logCount,
        error: orderResult.error
      });

      if (!orderResult.success) {
        console.error(`❌ Failed to process order ${orderId}: ${orderResult.error}`);
      } else {
        console.log(`\n✅ Order ${orderId} completed successfully`);
      }

      if (i < orderList.length - 1) {
        console.log(`\nWaiting 3 seconds before next order...\n`);
        await sleep(3000);
      }
    } catch (error) {
      console.error(`❌ Exception processing order ${orderId}:`, error.message);
      reportGenerator.recordOrderError(orderId, error);
      
      results.push({
        orderIndex: i + 1,
        merchantId,
        orderId,
        success: false,
        error: error.message
      });
    }
  }

  cleanupHandlers();
  const overallSuccess = results.every(r => r.success);
  reportGenerator.completeExecution(overallSuccess);

  console.log(`\n========================================`);
  console.log(`Sequential Processing Complete`);
  console.log(`========================================`);
  const successful = results.filter(r => r.success).length;
  const failed = results.filter(r => !r.success).length;
  console.log(`Successful: ${successful}`);
  console.log(`Failed: ${failed}`);
  console.log(`Total: ${results.length}`);
  console.log(`========================================\n`);

  return { success: failed === 0, results };
}

async function processSingleOrder(merchantId, orderId, config, orderIndex, totalOrders, maxJourneyTimeMs, reportGenerator) {
  let server = null;
  let orchestrator = null;
  let mocks = null;
  let progressInterval = null;

  const orderReport = reportGenerator.addOrder({
    orderId,
    merchantId,
    orderIndex,
    totalOrders
  });

  try {
    logger.info(`ART_PROGRESS: Order ${orderIndex}/${totalOrders} - Step 1: Fetching logs`, {
      orderId,
      orderIndex,
      totalOrders,
      phase: 'FETCH_LOGS'
    });
    
    let fetchResult = null;
    const maxFetchAttempts = 5;
    const fetchRetryIntervalMs = 2000;
    
    for (let attempt = 1; attempt <= maxFetchAttempts; attempt++) {
      const fetcher = new BatchLogFetcher({
        sessionToken: config.SESSION_TOKEN,
        outputPath: config.LOGS_FILE_PATH,
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
    
    const logs = await fetchLogsFromJSONFile(config.LOGS_FILE_PATH);

    if (logs.length === 0) {
      reportGenerator.finalizeOrder(orderId, {
        success: false,
        stopReason: 'No logs to process',
        logsProcessed: 0
      });
      return { success: false, logCount: 0, error: 'No logs to process' };
    }

    console.log(`Loaded ${logs.length} logs`);

    const filteredLogs = await filterAndSortLogs(logs, 'data/filtered-logs.json');
    
    if (filteredLogs.length === 0) {
      reportGenerator.finalizeOrder(orderId, {
        success: false,
        stopReason: 'No logs after filtering',
        logsProcessed: 0
      });
      return { success: false, logCount: 0, error: 'No logs after filtering' };
    }

    const finalFilteredLogs = await filterOrchestratorSkippableLogs(filteredLogs, 'data/final-filtered-logs.json');
    
    if (finalFilteredLogs.length === 0) {
      reportGenerator.finalizeOrder(orderId, {
        success: false,
        stopReason: 'No logs after second filtering',
        logsProcessed: 0
      });
      return { success: false, logCount: 0, error: 'No logs after second filtering' };
    }

    orderReport.logsTotal = finalFilteredLogs.length;
    console.log(`Ready to replay ${finalFilteredLogs.length} unique logs`);

    if (MOCK_CONFIG.enabled) {
      console.log('\nMock mode enabled - starting mock services...');
      const lspPort = new URL(MOCK_CONFIG.mockLspUrl).port || 4232;
      const gwPort = new URL(MOCK_CONFIG.mockGwUrl).port || 2344;

      mocks = createMockController({
        lspPort: parseInt(lspPort, 10),
        gwPort: parseInt(gwPort, 10),
        orchestratorUrl: `http://localhost:${config.PORT}`
      });

      await mocks.start(logs);

      SERVICE_MAP.LSP.baseUrl = MOCK_CONFIG.mockLspUrl;
      SERVICE_MAP.GW.baseUrl = MOCK_CONFIG.mockGwUrl;

      console.log(`Mock services started`);
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
      reportGenerator
    });

    if (config.onOrchestratorReady) {
      config.onOrchestratorReady(orchestrator, orderId);
      const loanApplicationIds = [...new Set(finalFilteredLogs
        .map(l => l.loan_application_id || l.loanApplicationId)
        .filter(Boolean))];
      for (const laId of loanApplicationIds) {
        config.onLoanApplicationId?.(laId);
      }
    } else {
      const app = createServer(orchestrator);
      await new Promise((resolve, reject) => {
        server = app.listen(config.PORT, () => {
          console.log(`\nART Server running on port ${config.PORT} for order ${orderId}`);
          resolve();
        });
        server.on('error', reject);
      });
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
      reportGenerator.markOrderStuck(orderId, {
        logTag: currentEntry?.logTag || 'unknown',
        logIndex: currentEntry?.index || 0,
        reason: `Timeout after ${Math.round(maxJourneyTimeMs / 1000 / 60)} minutes`
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
          ? `Timeout: Max journey time of ${Math.round(maxJourneyTimeMs / 1000 / 60)} minutes exceeded`
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
      config.registry?.unregister(config.sessionId);
    }

    if (mocks) {
      await mocks.stop();
    }

    return {
      success: !completionResult.timedOut && artResults.failed === 0,
      logCount: finalFilteredLogs.length,
      artResults
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
      config.registry?.unregister(config.sessionId);
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
  }
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
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

      if (Date.now() - stuckSince >= currentMaxRetryMs) {
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
