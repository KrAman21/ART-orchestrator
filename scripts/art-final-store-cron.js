#!/usr/bin/env node

import '../src/bootstrap-env.js';

import { mkdir, rename, stat, unlink, writeFile } from 'fs/promises';
import { dirname, resolve } from 'path';
import { fetchOrderIdsFromQAPI } from '../src/services/http-client.js';
import { BatchLogFetcher } from '../src/log-fetcher/index.js';
import {
  fetchLogsFromJSONFile,
  filterAndSortLogs,
  filterOrchestratorSkippableLogs
} from '../src/services/log-fetcher.js';

function parseOptionalInt(value, envName) {
  if (value === undefined || value === '') {
    return null;
  }

  const parsed = parseInt(value, 10);
  if (!Number.isInteger(parsed)) {
    throw new Error(`${envName} must be an integer`);
  }

  return parsed;
}

function parseCsv(value) {
  return value
    ? value.split(',').map(item => item.trim()).filter(Boolean)
    : [];
}

function parseBooleanOption(value, defaultValue = true) {
  if (value === undefined || value === null || value === '') {
    return defaultValue;
  }

  if (typeof value === 'boolean') {
    return value;
  }

  const normalized = String(value).trim().toLowerCase();
  if (['true', '1', 'yes', 'y', 'on'].includes(normalized)) {
    return true;
  }

  if (['false', '0', 'no', 'n', 'off'].includes(normalized)) {
    return false;
  }

  return defaultValue;
}

function sanitizePathSegment(value) {
  return String(value || 'unknown')
    .trim()
    .replace(/[^a-zA-Z0-9._=-]+/g, '_')
    .replace(/^_+|_+$/g, '') || 'unknown';
}

function resolveInterval() {
  const explicitStartDate = process.env.QAPI_START_DATE || process.env.START_DATE || null;
  const explicitEndDate = process.env.QAPI_END_DATE || process.env.END_DATE || null;

  if (explicitStartDate && explicitEndDate) {
    return {
      startDate: explicitStartDate,
      endDate: explicitEndDate,
      mode: 'explicit'
    };
  }

  const lastMinutes =
    parseOptionalInt(process.env.ART_FINAL_STORE_LOOKBACK_MINUTES, 'ART_FINAL_STORE_LOOKBACK_MINUTES') ??
    parseOptionalInt(process.env.LAST_MINUTES, 'LAST_MINUTES') ??
    60;
  const logDelayMinutes =
    parseOptionalInt(process.env.ART_FINAL_STORE_LOG_DELAY_MINUTES, 'ART_FINAL_STORE_LOG_DELAY_MINUTES') ??
    parseOptionalInt(process.env.ORDER_FETCH_LOG_DELAY_MINUTES, 'ORDER_FETCH_LOG_DELAY_MINUTES') ??
    5;

  if (lastMinutes <= 0) {
    throw new Error('ART_FINAL_STORE_LOOKBACK_MINUTES must be a positive integer');
  }

  if (logDelayMinutes < 0) {
    throw new Error('ART_FINAL_STORE_LOG_DELAY_MINUTES must be zero or a positive integer');
  }

  const endDate = new Date(Date.now() - logDelayMinutes * 60 * 1000);
  const startDate = new Date(endDate.getTime() - lastMinutes * 60 * 1000);

  return {
    startDate: startDate.toISOString(),
    endDate: endDate.toISOString(),
    mode: 'lookback',
    lastMinutes,
    logDelayMinutes
  };
}

async function writeJsonAtomic(filePath, payload) {
  const absolutePath = resolve(process.cwd(), filePath);
  const tempPath = `${absolutePath}.${process.pid}.${Date.now()}.tmp`;

  await mkdir(dirname(absolutePath), { recursive: true });
  await writeFile(tempPath, `${JSON.stringify(payload, null, 2)}\n`, 'utf-8');
  await rename(tempPath, absolutePath);

  return absolutePath;
}

async function assertFileWritten(filePath) {
  const absolutePath = resolve(process.cwd(), filePath);
  const fileStat = await stat(absolutePath);

  if (!fileStat.isFile() || fileStat.size === 0) {
    throw new Error(`Expected non-empty file at ${absolutePath}`);
  }

  return absolutePath;
}

async function deleteIntermediateArtifacts(filePaths) {
  const deleted = [];

  for (const filePath of filePaths) {
    const absolutePath = resolve(process.cwd(), filePath);

    try {
      await unlink(absolutePath);
      deleted.push(absolutePath);
    } catch (error) {
      if (error.code !== 'ENOENT') {
        throw error;
      }
    }
  }

  return deleted;
}

function buildOrderStorePath(storeRoot, merchantId, orderId) {
  return [
    storeRoot.replace(/\/+$/, ''),
    'orders',
    sanitizePathSegment(merchantId),
    `${sanitizePathSegment(orderId)}.json`
  ].join('/');
}

function buildOrderArtifactPath(storeRoot, merchantId, orderId, fileName) {
  return [
    storeRoot.replace(/\/+$/, ''),
    'artifacts',
    sanitizePathSegment(merchantId),
    sanitizePathSegment(orderId),
    fileName
  ].join('/');
}

function buildOrderListPayload(stats, orders) {
  const successfulKeys = new Set(
    stats.results
      .filter(result => result.success)
      .map(result => `${result.merchantId}:${result.orderId}`)
  );
  const readyOrders = orders.filter(order =>
    successfulKeys.has(`${order.merchantId}:${order.orderId}`)
  );

  return {
    schemaVersion: 1,
    generatedAt: new Date().toISOString(),
    source: 'art-final-store-cron',
    runId: stats.runId,
    interval: stats.interval,
    merchantIds: stats.merchantIds,
    flowType: stats.flowType,
    subType: stats.subType,
    count: readyOrders.length,
    orders: readyOrders
  };
}

async function fetchAndPrepareReplayLogs(merchantId, orderId, options) {
  const rawLogsPath = buildOrderArtifactPath(options.storeRoot, merchantId, orderId, 'logs.json');
  const filteredLogsPath = buildOrderArtifactPath(options.storeRoot, merchantId, orderId, 'filtered-logs.json');
  const finalFilteredLogsPath = buildOrderArtifactPath(options.storeRoot, merchantId, orderId, 'final-filtered-logs.json');
  const maxFetchAttempts = options.maxFetchAttempts;
  const fetchRetryIntervalMs = options.fetchRetryIntervalMs;
  let fetchResult = null;

  for (let attempt = 1; attempt <= maxFetchAttempts; attempt++) {
    const fetcher = new BatchLogFetcher({
      sessionToken: process.env.SESSION_TOKEN,
      outputPath: rawLogsPath,
      delayBetweenRequests: options.sourceDelayMs,
      maxRetries: options.maxRetries,
      retryDelay: options.retryDelayMs,
      useOrderContextLookup: options.useOrderContextLookup
    });

    fetchResult = await fetcher.fetchLogsForOrders([{ merchantId, orderId }]);

    if (fetchResult.success && fetchResult.stats.totalLogs > 0) {
      break;
    }

    console.warn(`[worker] fetch attempt ${attempt}/${maxFetchAttempts} failed for ${orderId}`, {
      totalLogs: fetchResult?.stats?.totalLogs || 0,
      error: fetchResult?.error || 'No logs found'
    });

    if (attempt < maxFetchAttempts) {
      await new Promise(resolvePromise => setTimeout(resolvePromise, fetchRetryIntervalMs));
    }
  }

  if (!fetchResult?.success || fetchResult.stats.totalLogs === 0) {
    throw new Error(`No logs found after ${maxFetchAttempts} attempts`);
  }

  const rawLogs = await fetchLogsFromJSONFile(rawLogsPath);
  if (rawLogs.length === 0) {
    throw new Error('No logs to process after fetch');
  }

  const filteredLogs = await filterAndSortLogs(rawLogs, filteredLogsPath);
  if (filteredLogs.length === 0) {
    throw new Error('No logs remaining after filterAndSortLogs');
  }

  const finalFilteredLogs = await filterOrchestratorSkippableLogs(filteredLogs, finalFilteredLogsPath);
  if (finalFilteredLogs.length === 0) {
    throw new Error('No logs remaining after filterOrchestratorSkippableLogs');
  }

  const finalFilteredLogsAbsolutePath = await assertFileWritten(finalFilteredLogsPath);
  await deleteIntermediateArtifacts([rawLogsPath, filteredLogsPath]);

  const orderFetchResult = Array.isArray(fetchResult.results) ? fetchResult.results[0] : null;

  return {
    fetchResult,
    orderFetchResult,
    rawLogs,
    filteredLogs,
    finalFilteredLogs,
    rawLogsPath,
    filteredLogsPath,
    finalFilteredLogsPath,
    finalFilteredLogsAbsolutePath
  };
}

async function runWorker(workerId, queue, options, stats) {
  while (queue.length > 0) {
    const order = queue.shift();
    const startedAt = new Date().toISOString();

    try {
      console.log(`[worker ${workerId}] fetching and preparing ${order.merchantId}/${order.orderId}`);
      const prepared = await fetchAndPrepareReplayLogs(order.merchantId, order.orderId, options);
      const result = prepared.orderFetchResult || {};
      const fetchedAt = new Date().toISOString();
      const orderFile = buildOrderStorePath(options.storeRoot, order.merchantId, order.orderId);
      const artifact = {
        schemaVersion: 2,
        merchantId: order.merchantId,
        orderId: order.orderId,
        success: true,
        fetchedAt,
        startedAt,
        interval: options.interval,
        readyForReplay: true,
        pipeline: [
          'BatchLogFetcher.fetchLogsForOrders',
          'fetchLogsFromJSONFile',
          'filterAndSortLogs',
          'filterOrchestratorSkippableLogs'
        ],
        context: result.context || { customerId: null, loanApplicationIds: [] },
        sourceCounts: result.sourceCounts || {},
        rawLogCount: prepared.rawLogs.length,
        filteredLogCount: prepared.filteredLogs.length,
        finalLogCount: prepared.finalFilteredLogs.length,
        count: prepared.finalFilteredLogs.length,
        error: null,
        artifacts: {
          finalFilteredLogsPath: prepared.finalFilteredLogsAbsolutePath
        },
        logs: prepared.finalFilteredLogs
      };

      const absolutePath = await writeJsonAtomic(orderFile, artifact);
      stats.results.push({
        merchantId: order.merchantId,
        orderId: order.orderId,
        success: artifact.success,
        count: artifact.count,
        rawLogCount: artifact.rawLogCount,
        filteredLogCount: artifact.filteredLogCount,
        finalLogCount: artifact.finalLogCount,
        path: absolutePath,
        error: artifact.error
      });

      stats.successful += 1;
      stats.totalLogs += artifact.count;

      console.log(`[worker ${workerId}] wrote ${artifact.count} ready replay logs for ${order.orderId}`);
    } catch (error) {
      stats.failed += 1;
      stats.results.push({
        merchantId: order.merchantId,
        orderId: order.orderId,
        success: false,
        count: 0,
        path: null,
        error: error.message
      });
      console.error(`[worker ${workerId}] failed ${order.merchantId}/${order.orderId}: ${error.message}`);
    }
  }
}

async function main() {
  const storeRoot = process.env.ART_FINAL_STORE_DIR || 'data/art-final-store';
  const workerCount =
    parseOptionalInt(process.env.ART_FINAL_STORE_WORKERS, 'ART_FINAL_STORE_WORKERS') ??
    parseOptionalInt(process.env.CRON_WORKERS, 'CRON_WORKERS') ??
    4;
  const orderLimit =
    parseOptionalInt(process.env.ART_FINAL_STORE_ORDER_LIMIT, 'ART_FINAL_STORE_ORDER_LIMIT') ??
    parseOptionalInt(process.env.QAPI_ORDER_LIMIT, 'QAPI_ORDER_LIMIT') ??
    1000;
  const merchantIds = parseCsv(process.env.MERCHANT_IDS);
  const merchantId = process.env.MERCHANT_ID || process.env.QAPI_MERCHANT_ID || merchantIds[0] || 'flipkart';
  const resolvedMerchantIds = merchantIds.length > 0 ? merchantIds : [merchantId];
  const flowType = process.env.FLOW_TYPE || 'NTB';
  const subType = process.env.SUB_TYPE || 'CHECKOUT';
  const useOrderContextLookup = parseBooleanOption(
    process.env.USE_FETCH_ORDER_CONTEXT ??
      process.env.FETCH_ORDER_CONTEXT_ENABLED ??
      process.env.ART_FETCH_ORDER_CONTEXT_ENABLED,
    true
  );
  const interval = resolveInterval();
  const runId = new Date().toISOString().replace(/[:.]/g, '-');

  if (workerCount <= 0) {
    throw new Error('ART_FINAL_STORE_WORKERS must be a positive integer');
  }

  if (orderLimit <= 0 || orderLimit > 1000) {
    throw new Error('ART_FINAL_STORE_ORDER_LIMIT must be between 1 and 1000');
  }

  console.log('\n========================================');
  console.log('ART Final Store Cron Fetch');
  console.log('========================================');
  console.log(`Store Root: ${storeRoot}`);
  console.log(`Merchant IDs: ${resolvedMerchantIds.join(', ')}`);
  console.log(`Date Range: ${interval.startDate} to ${interval.endDate}`);
  console.log(`Workers: ${workerCount}`);
  console.log(`Max Orders: ${orderLimit}`);
  console.log(`Use Order Context Lookup: ${useOrderContextLookup}`);
  if (flowType) console.log(`Flow Type: ${flowType}`);
  if (subType) console.log(`Sub Type: ${subType}`);
  console.log('========================================\n');

  const qapiResult = await fetchOrderIdsFromQAPI(
    interval.startDate,
    interval.endDate,
    resolvedMerchantIds,
    {
      merchantId,
      flowType,
      subType
    }
  );

  if (!qapiResult.success) {
    throw new Error(`Failed to fetch order IDs: ${qapiResult.error}`);
  }

  const orders = (Array.isArray(qapiResult.orders) ? qapiResult.orders : [])
    .slice(0, orderLimit)
    .map(order => ({
      merchantId: order.merchantId || merchantId,
      orderId: order.orderId
    }))
    .filter(order => order.orderId);

  const stats = {
    runId,
    startedAt: new Date().toISOString(),
    successful: 0,
    failed: 0,
    totalLogs: 0,
    results: []
  };

  if (orders.length === 0) {
    console.log('No orders found for this interval.');
  } else {
    const queue = [...orders];
    const workersToStart = Math.min(workerCount, queue.length);
    const workerOptions = {
      storeRoot,
      interval,
      sourceDelayMs:
        parseOptionalInt(process.env.ART_FINAL_STORE_SOURCE_DELAY_MS, 'ART_FINAL_STORE_SOURCE_DELAY_MS') ?? 500,
      maxRetries:
        parseOptionalInt(process.env.ART_FINAL_STORE_MAX_RETRIES, 'ART_FINAL_STORE_MAX_RETRIES') ?? 3,
      retryDelayMs:
        parseOptionalInt(process.env.ART_FINAL_STORE_RETRY_DELAY_MS, 'ART_FINAL_STORE_RETRY_DELAY_MS') ?? 2000,
      useOrderContextLookup,
      maxFetchAttempts:
        parseOptionalInt(process.env.ART_FINAL_STORE_FETCH_ATTEMPTS, 'ART_FINAL_STORE_FETCH_ATTEMPTS') ?? 5,
      fetchRetryIntervalMs:
        parseOptionalInt(process.env.ART_FINAL_STORE_FETCH_RETRY_INTERVAL_MS, 'ART_FINAL_STORE_FETCH_RETRY_INTERVAL_MS') ?? 2000
    };

    await Promise.all(
      Array.from({ length: workersToStart }, (_, index) =>
        runWorker(index + 1, queue, workerOptions, stats)
      )
    );
  }

  stats.finishedAt = new Date().toISOString();
  stats.total = orders.length;
  stats.storeRoot = resolve(process.cwd(), storeRoot);
  stats.interval = interval;
  stats.merchantIds = resolvedMerchantIds;
  stats.flowType = flowType || null;
  stats.subType = subType || null;

  const manifestPath = await writeJsonAtomic(`${storeRoot}/runs/${runId}.json`, stats);
  await writeJsonAtomic(`${storeRoot}/latest-run.json`, stats);
  const orderListPayload = buildOrderListPayload(stats, orders);
  const orderListPath = await writeJsonAtomic(`${storeRoot}/runs/${runId}-order-list.json`, orderListPayload);
  await writeJsonAtomic(`${storeRoot}/latest-order-list.json`, orderListPayload);

  console.log('\n========================================');
  console.log('ART Final Store Cron Complete');
  console.log('========================================');
  console.log(`Orders: ${stats.total}`);
  console.log(`Successful: ${stats.successful}`);
  console.log(`Failed: ${stats.failed}`);
  console.log(`Total Logs: ${stats.totalLogs}`);
  console.log(`Manifest: ${manifestPath}`);
  console.log(`Order List: ${orderListPath}`);
  console.log('========================================\n');

  if (stats.failed > 0) {
    process.exitCode = 1;
  }
}

main().catch(error => {
  console.error(`ART final store cron failed: ${error.message}`);
  process.exitCode = 1;
});
