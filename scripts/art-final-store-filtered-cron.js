#!/usr/bin/env node

import '../src/bootstrap-env.js';

import { mkdir, rename, rm, stat, unlink, writeFile } from 'fs/promises';
import { dirname, isAbsolute, resolve } from 'path';
import { fileURLToPath } from 'url';
import { QAPI_CONFIG } from '../src/config.js';
import { BatchLogFetcher } from '../src/log-fetcher/index.js';
import {
  fetchLogsFromJSONFile,
  filterAndSortLogs,
  filterOrchestratorSkippableLogs
} from '../src/services/log-fetcher.js';
import { logger } from '../src/utils/logger.js';

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(SCRIPT_DIR, '..');

const DEFAULT_FILTER_CONFIG = [
  // { merchantId: 'flipkart', status: 'SUCCESS', lenderOrgId: 'DMI' },
  // { merchantId: 'flipkart', status: 'SUCCESS', lenderOrgId: 'HDB' },
  // { merchantId: 'flipkartSM', status: 'SUCCESS' }
];

const DEFAULT_SUCCESS_SAMPLE_MERCHANT_IDS = [
  'flipkart',
  'flipkartSM',
  'starhealth',
  'adityabirla_health',
  'amity'
];

function parseBooleanOption(value, defaultValue = false) {
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

function resolveFromRepoRoot(targetPath) {
  if (isAbsolute(targetPath)) {
    return targetPath;
  }

  return resolve(REPO_ROOT, targetPath);
}

function sanitizePathSegment(value) {
  return String(value || 'unknown')
    .trim()
    .replace(/[^a-zA-Z0-9._=-]+/g, '_')
    .replace(/^_+|_+$/g, '') || 'unknown';
}

function shuffle(array) {
  const cloned = [...array];
  for (let index = cloned.length - 1; index > 0; index -= 1) {
    const swapIndex = Math.floor(Math.random() * (index + 1));
    [cloned[index], cloned[swapIndex]] = [cloned[swapIndex], cloned[index]];
  }
  return cloned;
}

function dedupeOrders(orders) {
  const uniqueOrders = [];
  const seen = new Set();

  for (const order of orders) {
    if (!order?.orderId) {
      continue;
    }

    const merchantId = order.merchantId ? String(order.merchantId).trim() : null;
    const key = `${merchantId || ''}:${order.orderId}`;
    if (seen.has(key)) {
      continue;
    }

    seen.add(key);
    uniqueOrders.push({
      merchantId,
      orderId: order.orderId
    });
  }

  return uniqueOrders;
}

function addMinutes(isoString, minutesToAdd) {
  return new Date(new Date(isoString).getTime() + minutesToAdd * 60 * 1000).toISOString();
}

function minIsoDate(left, right) {
  return new Date(left).getTime() <= new Date(right).getTime() ? left : right;
}

function buildWindowIntervals(interval, totalOrderLimit, windowBatchSize, windowMinutes) {
  const windowsNeeded = Math.ceil(totalOrderLimit / windowBatchSize);
  const windows = [];
  let currentStart = interval.startDate;

  for (let index = 0; index < windowsNeeded; index += 1) {
    const nextEnd = minIsoDate(addMinutes(currentStart, windowMinutes), interval.endDate);
    windows.push({
      index: index + 1,
      startDate: currentStart,
      endDate: nextEnd,
      maxOrders: Math.min(windowBatchSize, totalOrderLimit - index * windowBatchSize)
    });

    if (new Date(nextEnd).getTime() >= new Date(interval.endDate).getTime()) {
      break;
    }

    currentStart = nextEnd;
  }

  return windows;
}

function normalizeFilterDescriptor(filter) {
  if (!filter || typeof filter !== 'object') {
    return null;
  }

  const field = String(filter.field || filter.key || '').trim();
  if (!field) {
    return null;
  }

  const condition = String(filter.condition || (Array.isArray(filter.val || filter.value) ? 'In' : 'Equals')).trim();
  const value = filter.val ?? filter.value;

  if (value === undefined || value === null || value === '') {
    return null;
  }

  return {
    field,
    condition,
    val: value
  };
}

function combineFiltersWithAnd(filters) {
  const normalized = filters.filter(Boolean);
  if (normalized.length === 0) {
    return null;
  }

  return normalized.slice(1).reduce((left, right) => ({
    and: { left, right }
  }), normalized[0]);
}

function buildExtendedOrderFetchFilters(filterConfig) {
  const filters = [
    filterConfig.merchantId
      ? {
          field: 'merchant_id',
          condition: 'Equals',
          val: filterConfig.merchantId
        }
      : null,
    filterConfig.flowType
      ? {
          field: 'flow_type',
          condition: 'Equals',
          val: filterConfig.flowType
        }
      : null,
    filterConfig.subType
      ? {
          field: 'sub_type',
          condition: 'Equals',
          val: filterConfig.subType
        }
      : null,
    filterConfig.status
      ? {
          field: 'status',
          condition: 'Equals',
          val: filterConfig.status
        }
      : null,
    filterConfig.lenderOrgId
      ? {
          field: 'lender_org_id',
          condition: 'Equals',
          val: filterConfig.lenderOrgId
        }
      : null,
    ...(Array.isArray(filterConfig.filters)
      ? filterConfig.filters.map(normalizeFilterDescriptor).filter(Boolean)
      : [])
  ];

  return combineFiltersWithAnd(filters);
}

async function fetchOrderIdsFromQAPIExtended(startDate, endDate, filterConfig) {
  const endpoint = '/analytics/query';
  const url = `${QAPI_CONFIG.baseUrl}${endpoint}`;
  const payload = {
    metric: 'fetch_order_id',
    dimensions: [],
    filters: buildExtendedOrderFetchFilters(filterConfig),
    domain: 'orderAnalytics',
    interval: {
      start: startDate,
      end: endDate
    }
  };

  try {
    const response = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Accept': 'application/json',
        'Authorization': QAPI_CONFIG.authorization,
        'Consumer-Credit-Dashboard': 'Consumer-Credit-Dashboard',
        'Referer': 'https://dashboard.credit.juspay.in/'
      },
      body: JSON.stringify(payload)
    });

    if (!response.ok) {
      const errorText = await response.text();
      return {
        success: false,
        error: `HTTP error! status: ${response.status}`,
        message: errorText
      };
    }

    const responseText = await response.text();
    let data;

    try {
      data = JSON.parse(responseText);
    } catch (error) {
      const lines = responseText.split('\n').filter(line => line.trim());
      data = { result: lines.map(line => JSON.parse(line)).filter(Boolean), status: 'SUCCESS' };
    }

    let resultRows = [];
    if (data.result && Array.isArray(data.result)) {
      resultRows = data.result;
    } else if (data.result && typeof data.result === 'object' && data.result.rows) {
      resultRows = data.result.rows;
    } else if (data.data && Array.isArray(data.data)) {
      resultRows = data.data;
    } else if (Array.isArray(data)) {
      resultRows = data;
    }

    const normalizedRows = resultRows.map(row => {
      if (typeof row === 'string') {
        try {
          return JSON.parse(row);
        } catch {
          return { raw: row };
        }
      }
      return row;
    });

    const orders = normalizedRows
      .map(row => ({
        orderId: row.fetch_order_id || row.order_id || row.orderId || row.ORDER_ID || row.id || null,
        merchantId:
          row.merchant_id ||
          row.merchantId ||
          row.MERCHANT_ID ||
          filterConfig.merchantId
      }))
      .filter(order => order.orderId && String(order.orderId).trim() !== '');

    return {
      success: true,
      orders: dedupeOrders(orders),
      count: orders.length
    };
  } catch (error) {
    logger.error('Extended QAPI fetch failed', {
      error: error.message,
      filterConfig,
      startDate,
      endDate
    });
    return {
      success: false,
      error: error.message
    };
  }
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
    parseOptionalInt(process.env.ART_FILTERED_STORE_LOOKBACK_MINUTES, 'ART_FILTERED_STORE_LOOKBACK_MINUTES') ??
    parseOptionalInt(process.env.ART_FINAL_STORE_LOOKBACK_MINUTES, 'ART_FINAL_STORE_LOOKBACK_MINUTES') ??
    parseOptionalInt(process.env.LAST_MINUTES, 'LAST_MINUTES') ??
    60;
  const logDelayMinutes =
    parseOptionalInt(process.env.ART_FILTERED_STORE_LOG_DELAY_MINUTES, 'ART_FILTERED_STORE_LOG_DELAY_MINUTES') ??
    parseOptionalInt(process.env.ART_FINAL_STORE_LOG_DELAY_MINUTES, 'ART_FINAL_STORE_LOG_DELAY_MINUTES') ??
    parseOptionalInt(process.env.ORDER_FETCH_LOG_DELAY_MINUTES, 'ORDER_FETCH_LOG_DELAY_MINUTES') ??
    5;

  if (lastMinutes <= 0) {
    throw new Error('ART_FILTERED_STORE_LOOKBACK_MINUTES must be a positive integer');
  }

  if (logDelayMinutes < 0) {
    throw new Error('ART_FILTERED_STORE_LOG_DELAY_MINUTES must be zero or a positive integer');
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
  const absolutePath = resolveFromRepoRoot(filePath);
  const tempPath = `${absolutePath}.${process.pid}.${Date.now()}.tmp`;

  await mkdir(dirname(absolutePath), { recursive: true });
  await writeFile(tempPath, `${JSON.stringify(payload, null, 2)}\n`, 'utf-8');
  await rename(tempPath, absolutePath);

  return absolutePath;
}

async function assertFileWritten(filePath) {
  const absolutePath = resolveFromRepoRoot(filePath);
  const fileStat = await stat(absolutePath);

  if (!fileStat.isFile() || fileStat.size === 0) {
    throw new Error(`Expected non-empty file at ${absolutePath}`);
  }

  return absolutePath;
}

async function deleteIntermediateArtifacts(filePaths) {
  for (const filePath of filePaths) {
    const absolutePath = resolveFromRepoRoot(filePath);

    try {
      await unlink(absolutePath);
    } catch (error) {
      if (error.code !== 'ENOENT') {
        throw error;
      }
    }
  }
}

function buildOrderStorePath(storeRoot, merchantId, orderId) {
  const orderPrefix = sanitizePathSegment(orderId);
  return [
    storeRoot.replace(/\/+$/, ''),
    `${orderPrefix}.json`
  ].join('/');
}

function buildOrderArtifactPath(storeRoot, merchantId, orderId, fileName) {
  const merchantPrefix = sanitizePathSegment(merchantId);
  const orderPrefix = sanitizePathSegment(orderId);
  return [
    storeRoot.replace(/\/+$/, ''),
    '.tmp',
    `${merchantPrefix}__${orderPrefix}`,
    fileName
  ].join('/');
}

function buildOrderListPayload(stats, orders) {
  const successfulKeys = new Set(
    (stats.readyOrders || []).map(order => `${order.merchantId}:${order.orderId}`)
  );
  const readyOrders = orders.filter(order =>
    successfulKeys.has(`${order.merchantId}:${order.orderId}`)
  );

  return {
    schemaVersion: 1,
    generatedAt: new Date().toISOString(),
    source: 'art-final-store-filtered-cron',
    runId: stats.runId,
    interval: stats.interval,
    flowType: stats.flowType,
    subType: stats.subType,
    filterConfig: stats.filterConfig,
    successSampleCount: stats.successSampleCount,
    batching: stats.batching,
    count: readyOrders.length,
    orders: readyOrders
  };
}

function normalizeFilterConfig() {
  const rawConfig = process.env.ART_FILTER_CONFIG_JSON
    ? JSON.parse(process.env.ART_FILTER_CONFIG_JSON)
    : DEFAULT_FILTER_CONFIG;

  if (!Array.isArray(rawConfig)) {
    throw new Error('ART_FILTER_CONFIG_JSON must be a JSON array');
  }

  return rawConfig
    .map((entry, index) => {
      if (!entry || typeof entry !== 'object') {
        throw new Error(`Filter config at index ${index} must be an object`);
      }

      const merchantIdRaw = entry.merchantId || entry.merchant_id;
      const merchantId = merchantIdRaw === undefined || merchantIdRaw === null
        ? null
        : String(merchantIdRaw).trim();
      const status = entry.status ? String(entry.status).trim() : null;
      const lenderOrgId = entry.lenderOrgId || entry.lender_org_id
        ? String(entry.lenderOrgId || entry.lender_org_id).trim()
        : null;
      const flowType = entry.flowType || entry.flow_type || null;
      const subType = entry.subType || entry.sub_type || null;

      return {
        merchantId,
        status,
        lenderOrgId,
        flowType: flowType ? String(flowType).trim() : null,
        subType: subType ? String(subType).trim() : null,
        filters: Array.isArray(entry.filters) ? entry.filters : []
      };
    });
}

async function fetchOrdersForConfig(interval, filterConfig, orderLimitPerFilter) {
  const qapiResult = await fetchOrderIdsFromQAPIExtended(interval.startDate, interval.endDate, filterConfig);

  if (!qapiResult.success) {
    throw new Error(`Failed to fetch order IDs for ${JSON.stringify(filterConfig)}: ${qapiResult.error}`);
  }

  return (Array.isArray(qapiResult.orders) ? qapiResult.orders : [])
    .slice(0, orderLimitPerFilter)
    .map(order => ({
      merchantId: order.merchantId || filterConfig.merchantId,
      orderId: order.orderId
    }))
    .filter(order => order.orderId);
}

async function fetchOrdersForConfigs(interval, filterConfigEntries, orderLimit, debugLogsEnabled) {
  const combinedOrders = [];

  for (const entry of filterConfigEntries) {
    const orders = await fetchOrdersForConfig(interval, entry, orderLimit);
    combinedOrders.push(...orders);

    if (debugLogsEnabled) {
      console.log(
        `[debug] fetched ${orders.length} candidate orders for window ${interval.startDate} -> ${interval.endDate}`,
        entry
      );
    }

    if (combinedOrders.length >= orderLimit) {
      break;
    }
  }

  return dedupeOrders(combinedOrders).slice(0, orderLimit);
}

async function fetchAndPrepareReplayLogs(merchantId, orderId, options) {
  const rawLogsPath = buildOrderArtifactPath(options.storeRoot, merchantId, orderId, 'logs.json');
  const filteredLogsPath = buildOrderArtifactPath(options.storeRoot, merchantId, orderId, 'filtered-logs.json');
  const finalFilteredLogsPath = buildOrderArtifactPath(options.storeRoot, merchantId, orderId, 'final-filtered-logs.json');
  const maxFetchAttempts = options.maxFetchAttempts;
  const fetchRetryIntervalMs = options.fetchRetryIntervalMs;
  let fetchResult = null;

  for (let attempt = 1; attempt <= maxFetchAttempts; attempt += 1) {
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
  await deleteIntermediateArtifacts([rawLogsPath, filteredLogsPath, finalFilteredLogsPath]);

  const orderFetchResult = Array.isArray(fetchResult.results) ? fetchResult.results[0] : null;

  return {
    fetchResult,
    orderFetchResult,
    rawLogs,
    filteredLogs,
    finalFilteredLogs,
    finalFilteredLogsAbsolutePath
  };
}

async function runWorker(workerId, queue, options, stats) {
  while (queue.length > 0) {
    const order = queue.shift();
    if (!order) {
      return;
    }

    try {
      const prepared = await fetchAndPrepareReplayLogs(order.merchantId, order.orderId, options);
      const result = prepared.orderFetchResult || {};
      const orderFile = buildOrderStorePath(options.storeRoot, order.merchantId, order.orderId);
      const artifact = {
        schemaVersion: 2,
        merchantId: order.merchantId,
        orderId: order.orderId,
        success: true,
        fetchedAt: new Date().toISOString(),
        interval: options.interval,
        readyForReplay: true,
        context: result.context || { customerId: null, loanApplicationIds: [] },
        sourceCounts: result.sourceCounts || {},
        rawLogCount: prepared.rawLogs.length,
        filteredLogCount: prepared.filteredLogs.length,
        finalLogCount: prepared.finalFilteredLogs.length,
        count: prepared.finalFilteredLogs.length,
        artifacts: {
          finalFilteredLogsPath: prepared.finalFilteredLogsAbsolutePath
        },
        logs: prepared.finalFilteredLogs
      };

      const absolutePath = await writeJsonAtomic(orderFile, artifact);
      const resultSummary = {
        merchantId: order.merchantId,
        orderId: order.orderId,
        success: true,
        count: artifact.count,
        path: absolutePath
      };

      if (options.debugLogsEnabled) {
        stats.results.push(resultSummary);
      }
      stats.readyOrders.push({
        merchantId: order.merchantId,
        orderId: order.orderId
      });
      stats.successful += 1;
      stats.totalLogs += artifact.count;

      if (stats.successful % options.progressEvery === 0) {
        console.log(`[progress] ready ${stats.successful}/${stats.total}`);
      }
    } catch (error) {
      stats.failed += 1;
      stats.results.push({
        merchantId: order.merchantId,
        orderId: order.orderId,
        success: false,
        count: 0,
        error: error.message,
        batchIndex: options.batchIndex,
        windowStart: options.interval.startDate,
        windowEnd: options.interval.endDate
      });

      if (options.debugLogsEnabled) {
        console.error(`[worker ${workerId}] failed ${order.merchantId}/${order.orderId}: ${error.message}`);
      }
    }
  }
}

async function replaceStoreAtomically(nextStoreRoot, finalStoreRoot) {
  const nextStorePath = resolveFromRepoRoot(nextStoreRoot);
  const finalStorePath = resolveFromRepoRoot(finalStoreRoot);
  const backupStorePath = `${finalStorePath}.backup`;

  // Move existing store to backup if it exists
  try {
    await stat(finalStorePath);
    await rename(finalStorePath, backupStorePath);
  } catch (error) {
    if (error.code !== 'ENOENT') {
      throw error;
    }
  }

  try {
    // Promote new store
    await rename(nextStorePath, finalStorePath);

    // Cleanup backup after successful swap
    await rm(backupStorePath, {
      recursive: true,
      force: true
    });
  } catch (error) {
    // Rollback if swap failed
    try {
      await rename(backupStorePath, finalStorePath);
    } catch (_) {}

    throw error;
  }

  return finalStorePath;
}

async function main() {
  const finalStoreRoot = process.env.ART_FILTERED_STORE_DIR || 'logsStore';
  const runId = new Date().toISOString().replace(/[:.]/g, '-');
  const storeRoot = `${finalStoreRoot}.next-${runId}`;
  const debugLogsEnabled = parseBooleanOption(process.env.ART_FILTERED_STORE_DEBUG, false);
  const workerCount =
    parseOptionalInt(process.env.ART_FILTERED_STORE_WORKERS, 'ART_FILTERED_STORE_WORKERS') ??
    parseOptionalInt(process.env.ART_FINAL_STORE_WORKERS, 'ART_FINAL_STORE_WORKERS') ??
    4;
  const totalOrderLimit =
    parseOptionalInt(process.env.ART_FILTERED_STORE_TOTAL_ORDER_LIMIT, 'ART_FILTERED_STORE_TOTAL_ORDER_LIMIT') ??
    parseOptionalInt(process.env.ART_FILTERED_STORE_ORDER_LIMIT, 'ART_FILTERED_STORE_ORDER_LIMIT') ??
    parseOptionalInt(process.env.ART_FILTERED_STORE_ORDER_LIMIT_PER_FILTER, 'ART_FILTERED_STORE_ORDER_LIMIT_PER_FILTER') ??
    3000;
  const windowBatchSize =
    parseOptionalInt(process.env.ART_FILTERED_STORE_BATCH_SIZE, 'ART_FILTERED_STORE_BATCH_SIZE') ??
    500;
  const windowMinutes =
    parseOptionalInt(process.env.ART_FILTERED_STORE_WINDOW_MINUTES, 'ART_FILTERED_STORE_WINDOW_MINUTES') ??
    30;
  const successSampleCount =
    parseOptionalInt(process.env.ART_SUCCESS_SAMPLE_COUNT, 'ART_SUCCESS_SAMPLE_COUNT') ??
    0;
  const useOrderContextLookup = parseBooleanOption(
    process.env.USE_FETCH_ORDER_CONTEXT ??
      process.env.FETCH_ORDER_CONTEXT_ENABLED ??
      process.env.ART_FETCH_ORDER_CONTEXT_ENABLED,
    false
  );
  const flowType = process.env.FLOW_TYPE || null;
  const subType = process.env.SUB_TYPE || null;
  const interval = resolveInterval();
  const filterConfig = normalizeFilterConfig();

  if (workerCount <= 0) {
    throw new Error('ART_FILTERED_STORE_WORKERS must be a positive integer');
  }

  if (totalOrderLimit <= 0) {
    throw new Error('ART_FILTERED_STORE_TOTAL_ORDER_LIMIT must be a positive integer');
  }

  if (windowBatchSize <= 0) {
    throw new Error('ART_FILTERED_STORE_BATCH_SIZE must be a positive integer');
  }

  if (windowMinutes <= 0) {
    throw new Error('ART_FILTERED_STORE_WINDOW_MINUTES must be a positive integer');
  }

  console.log('\n========================================');
  console.log('ART Filtered Final Store Fetch');
  console.log('========================================');
  console.log(`Store Root: ${storeRoot}`);
  console.log(`Date Range: ${interval.startDate} to ${interval.endDate}`);
  console.log(`Workers: ${workerCount}`);
  console.log(`Total Order Limit: ${totalOrderLimit}`);
  console.log(`Batch Size: ${windowBatchSize}`);
  console.log(`Window Minutes: ${windowMinutes}`);
  console.log(`Filter Config Count: ${filterConfig.length}`);
  console.log(`Success Sample Count: ${successSampleCount}`);
  console.log(`Use Order Context Lookup: ${useOrderContextLookup}`);
  console.log(`Debug Logs: ${debugLogsEnabled}`);
  console.log('========================================\n');

  const windows = buildWindowIntervals(interval, totalOrderLimit, windowBatchSize, windowMinutes);
  const stats = {
    runId,
    startedAt: new Date().toISOString(),
    successful: 0,
    failed: 0,
    totalLogs: 0,
    total: 0,
    results: [],
    readyOrders: [],
    processedBatches: [],
    interval,
    flowType,
    subType,
    filterConfig,
    successSampleCount,
    batching: {
      totalOrderLimit,
      batchSize: windowBatchSize,
      windowMinutes,
      totalWindowsPlanned: windows.length
    },
    storeRoot: resolveFromRepoRoot(storeRoot)
  };

  const allOrders = [];
  const seenOrderKeys = new Set();

  for (const window of windows) {
    const remainingCapacity = totalOrderLimit - allOrders.length;
    if (remainingCapacity <= 0) {
      break;
    }

    const windowInterval = {
      startDate: window.startDate,
      endDate: window.endDate,
      mode: 'windowed'
    };

    const configuredOrders = await fetchOrdersForConfigs(
      windowInterval,
      filterConfig,
      Math.min(window.maxOrders, remainingCapacity),
      debugLogsEnabled
    );

    const remainingAfterConfiguredOrders =
      Math.min(window.maxOrders, remainingCapacity) - configuredOrders.length;

    const successSampleMerchantIds = filterConfig.length > 0
      ? [...new Set(filterConfig.map(entry => entry.merchantId).filter(Boolean))]
      : DEFAULT_SUCCESS_SAMPLE_MERCHANT_IDS;

    const successOrders = remainingAfterConfiguredOrders > 0 && successSampleMerchantIds.length > 0
      ? await fetchOrdersForConfigs(
          windowInterval,
          successSampleMerchantIds.map(merchantId => ({
            merchantId,
            status: 'SUCCESS',
            lenderOrgId: null,
            flowType: null,
            subType: null,
            filters: []
          })),
          remainingAfterConfiguredOrders,
          debugLogsEnabled
        )
      : [];

    if (remainingAfterConfiguredOrders > 0 && successSampleMerchantIds.length === 0 && debugLogsEnabled) {
      console.warn(
        `[debug] skipping SUCCESS sample fetch for window ${window.startDate} -> ${window.endDate} because no merchantIds are configured`
      );
    }

    const sampledSuccessOrders = shuffle(successOrders).slice(0, remainingAfterConfiguredOrders);
    const windowOrders = dedupeOrders([...configuredOrders, ...sampledSuccessOrders])
      .filter(order => {
        const key = `${order.merchantId}:${order.orderId}`;
        if (seenOrderKeys.has(key)) {
          return false;
        }
        seenOrderKeys.add(key);
        return true;
      })
      .slice(0, Math.min(window.maxOrders, remainingCapacity));

    stats.processedBatches.push({
      batchIndex: window.index,
      windowStart: window.startDate,
      windowEnd: window.endDate,
      fetchedOrders: windowOrders.length,
      configuredOrders: configuredOrders.length,
      sampledSuccessOrders: sampledSuccessOrders.length
    });

    if (windowOrders.length === 0) {
      if (debugLogsEnabled) {
        console.log(`[debug] batch ${window.index} had no orders in ${window.startDate} -> ${window.endDate}`);
      }
      continue;
    }

    allOrders.push(...windowOrders);
    stats.total = allOrders.length;

    console.log(
      `[batch ${window.index}/${windows.length}] processing ${windowOrders.length} orders for ${window.startDate} -> ${window.endDate}`
    );

    const queue = [...windowOrders];
    const workerOptions = {
      storeRoot,
      interval: windowInterval,
      total: windowOrders.length,
      batchIndex: window.index,
      debugLogsEnabled,
      progressEvery:
        parseOptionalInt(process.env.ART_FILTERED_STORE_PROGRESS_EVERY, 'ART_FILTERED_STORE_PROGRESS_EVERY') ?? 25,
      sourceDelayMs:
        parseOptionalInt(process.env.ART_FILTERED_STORE_SOURCE_DELAY_MS, 'ART_FILTERED_STORE_SOURCE_DELAY_MS') ?? 500,
      maxRetries:
        parseOptionalInt(process.env.ART_FILTERED_STORE_MAX_RETRIES, 'ART_FILTERED_STORE_MAX_RETRIES') ?? 3,
      retryDelayMs:
        parseOptionalInt(process.env.ART_FILTERED_STORE_RETRY_DELAY_MS, 'ART_FILTERED_STORE_RETRY_DELAY_MS') ?? 2000,
      useOrderContextLookup,
      maxFetchAttempts:
        parseOptionalInt(process.env.ART_FILTERED_STORE_FETCH_ATTEMPTS, 'ART_FILTERED_STORE_FETCH_ATTEMPTS') ?? 5,
      fetchRetryIntervalMs:
        parseOptionalInt(process.env.ART_FILTERED_STORE_FETCH_RETRY_INTERVAL_MS, 'ART_FILTERED_STORE_FETCH_RETRY_INTERVAL_MS') ?? 2000
    };

    await Promise.all(
      Array.from({ length: Math.min(workerCount, windowOrders.length) }, (_, index) =>
        runWorker(index + 1, queue, workerOptions, stats)
      )
    );
  }

  stats.finishedAt = new Date().toISOString();
  stats.total = allOrders.length;

  const latestRunPath = await writeJsonAtomic(`${storeRoot}/latest-run.json`, stats);
  const orderListPayload = buildOrderListPayload(stats, allOrders);
  const latestOrderListPath = await writeJsonAtomic(`${storeRoot}/latest-order-list.json`, orderListPayload);

  if (stats.failed > 0) {
    const distinctErrors = [...new Set(
      stats.results
        .filter(result => result && result.success === false && result.error)
        .map(result => result.error)
    )].slice(0, 5);

    if (distinctErrors.length > 0) {
      console.error('Sample failure reasons:');
      for (const errorMessage of distinctErrors) {
        console.error(`- ${errorMessage}`);
      }
    }

    throw new Error(
      `Skipping active store replacement because ${stats.failed} orders failed`
    );
  }

  const activeStorePath = await replaceStoreAtomically(
    storeRoot,
    finalStoreRoot
  );

  console.log(`Active Store: ${activeStorePath}`);

  console.log('\n========================================');
  console.log('ART Filtered Final Store Complete');
  console.log('========================================');
  console.log(`Orders Selected: ${allOrders.length}`);
  console.log(`Successful: ${stats.successful}`);
  console.log(`Failed: ${stats.failed}`);
  console.log(`Latest Run: ${latestRunPath}`);
  console.log(`Latest Order List: ${latestOrderListPath}`);
  console.log('========================================\n');

  if (stats.failed > 0) {
    process.exitCode = 1;
  }
}

main().catch(error => {
  console.error(`ART filtered final store cron failed: ${error.message}`);
  process.exitCode = 1;
});
