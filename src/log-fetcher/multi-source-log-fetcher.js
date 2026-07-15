import { writeFile, mkdir } from 'fs/promises';
import { dirname, resolve } from 'path';
import {
  fetchS3TraceLogsByOrder,
  fetchS3TraceLogsByLoanApplicationId
} from './sources/s3-trace-logs-source.js';
import { compareLogsForReplay } from '../services/log-fetcher.js';
import {
  extractReplayContextFromLogs,
  resolveOrderContextFromLsp
} from './sources/order-context-resolver.js';
import { logger } from '../utils/logger.js';

function getCreatedAtTime(log) {
  const createdAt = log?.message?.created_at;
  const timestamp = createdAt ? new Date(createdAt).getTime() : Number.NaN;
  return Number.isNaN(timestamp) ? Number.POSITIVE_INFINITY : timestamp;
}

function getOrderStartTime(orderLogs) {
  const timestamps = (Array.isArray(orderLogs) ? orderLogs : [])
    .map(getCreatedAtTime)
    .filter(Number.isFinite);

  if (timestamps.length === 0) {
    return Number.POSITIVE_INFINITY;
  }

  return Math.min(...timestamps);
}

export function shouldMergeLoanApplicationLogs(orderLogs, loanApplicationLogs) {
  const orderStartTime = getOrderStartTime(orderLogs);
  if (!Number.isFinite(orderStartTime)) {
    return true;
  }

  const loanApplicationTimestamps = (Array.isArray(loanApplicationLogs) ? loanApplicationLogs : [])
    .map(getCreatedAtTime)
    .filter(Number.isFinite);

  if (loanApplicationTimestamps.length === 0) {
    return true;
  }

  return loanApplicationTimestamps.every(timestamp => timestamp >= orderStartTime);
}

function getTopLevelOrderIds(logs) {
  const orderIds = new Set();

  for (const log of Array.isArray(logs) ? logs : []) {
    const orderId = log?.message?.order_id;
    if (typeof orderId === 'string' && orderId.trim()) {
      orderIds.add(orderId.trim());
    }
  }

  return orderIds;
}

export function shouldDiscardLoanApplicationLogSet(orderId, orderLogs, loanApplicationLogs) {
  if (!shouldMergeLoanApplicationLogs(orderLogs, loanApplicationLogs)) {
    return {
      discard: true,
      reason: 'predates_order_start_time'
    };
  }

  const topLevelOrderIds = getTopLevelOrderIds(loanApplicationLogs);
  if (
    typeof orderId === 'string' &&
    orderId.trim() &&
    Array.from(topLevelOrderIds).some(loanLogOrderId => loanLogOrderId !== orderId)
  ) {
    return {
      discard: true,
      reason: 'mismatched_top_level_order_id',
      topLevelOrderIds: Array.from(topLevelOrderIds)
    };
  }

  return {
    discard: false,
    reason: null,
    topLevelOrderIds: Array.from(topLevelOrderIds)
  };
}

function dedupeLogs(logs) {
  const seen = new Set();
  const deduped = [];

  for (const log of logs) {
    const key = JSON.stringify(log);
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    deduped.push(log);
  }

  return deduped;
}

function mergeReplayContexts(primary, secondary) {
  const customerId = primary.customerId || secondary.customerId || null;
  const loanApplicationIds = [...new Set([
    ...(primary.loanApplicationIds || []),
    ...(secondary.loanApplicationIds || [])
  ])];

  return { customerId, loanApplicationIds };
}

export function shouldSkipReplayForMultipleOrderContextLaids(lspContext = {}) {
  return Boolean(
    lspContext?.success &&
    Array.isArray(lspContext?.loanApplicationIds) &&
    lspContext.loanApplicationIds.length > 1
  );
}

function buildSourceCounts(sourceResults) {
  const counts = {};

  for (const result of sourceResults) {
    const label = result.source?.label || 'unknown';
    counts[label] = (counts[label] || 0) + (result.count || 0);
  }

  return counts;
}

export class MultiSourceLogFetcher {
  constructor(options = {}) {
    this.sessionToken = options.sessionToken || process.env.SESSION_TOKEN || '';
    this.outputPath = options.outputPath || 'logs/s3-fetched-logs/logs.json';
    this.delayBetweenRequests = options.delayBetweenRequests || 500;
    this.maxRetries = options.maxRetries || 3;
    this.retryDelay = options.retryDelay || 2000;
    this.lspLookupBaseUrl = options.lspLookupBaseUrl || process.env.LSP_LOOKUP_BASE_URL || null;
    this.lspOrderStatusEndpoint = options.lspOrderStatusEndpoint || process.env.LSP_ORDER_STATUS_ENDPOINT || null;
  }

  async fetchLogsForOrder(merchantId, orderId, retries = 0) {
    logger.info(`Fetching replay logs for order: ${merchantId}/${orderId}`, {
      merchantId,
      orderId,
      attempt: retries + 1
    });

    const lspContext = await resolveOrderContextFromLsp(merchantId, orderId, {
      baseUrl: this.lspLookupBaseUrl || undefined,
      endpoint: this.lspOrderStatusEndpoint || undefined
    });

    if (shouldSkipReplayForMultipleOrderContextLaids(lspContext)) {
      const skipReason =
        `Skipping order replay because order-context API returned multiple loanApplicationIds: ${lspContext.loanApplicationIds.join(', ')}`;

      logger.warn(skipReason, {
        merchantId,
        orderId,
        loanApplicationIds: lspContext.loanApplicationIds,
        customerId: lspContext.customerId
      });

      return {
        success: true,
        skipped: true,
        skipReason,
        logs: [],
        count: 0,
        merchantId,
        orderId,
        context: {
          customerId: lspContext.customerId,
          loanApplicationIds: lspContext.loanApplicationIds
        },
        sourceCounts: {},
        sourceResults: []
      };
    }

    const orderLogsResult = await fetchS3TraceLogsByOrder(merchantId, orderId, this.sessionToken);

    if (!orderLogsResult.success) {
      if (retries < this.maxRetries) {
        logger.warn(`Order log fetch failed for ${orderId}, retrying (${retries + 1}/${this.maxRetries})...`, {
          error: orderLogsResult.error
        });
        await this.sleep(this.retryDelay * (retries + 1));
        return this.fetchLogsForOrder(merchantId, orderId, retries + 1);
      }

      return {
        success: false,
        error: orderLogsResult.error,
        logs: [],
        count: 0,
        merchantId,
        orderId,
        context: lspContext.success ? {
          customerId: lspContext.customerId,
          loanApplicationIds: lspContext.loanApplicationIds
        } : { customerId: null, loanApplicationIds: [] },
        sourceCounts: {}
      };
    }

    const logContext = extractReplayContextFromLogs(orderLogsResult.logs);
    const replayContext = mergeReplayContexts(
      lspContext.success ? lspContext : { customerId: null, loanApplicationIds: [] },
      logContext
    );

    const sourceResults = [orderLogsResult];
    const discardedLoanApplicationIds = [];
    const preservedLoanApplicationIds = [];
    for (const loanApplicationId of replayContext.loanApplicationIds) {
      const loanApplicationResult = await fetchS3TraceLogsByLoanApplicationId(loanApplicationId, this.sessionToken);
      const loanApplicationDiscardDecision = loanApplicationResult.success
        ? shouldDiscardLoanApplicationLogSet(orderId, orderLogsResult.logs, loanApplicationResult.logs)
        : { discard: false, reason: null, topLevelOrderIds: [] };

      if (loanApplicationResult.success && loanApplicationDiscardDecision.discard) {
        if (loanApplicationDiscardDecision.reason === 'predates_order_start_time') {
          logger.warn('Discarding full LAID log set because at least one log predates order start time', {
            merchantId,
            orderId,
            loanApplicationId,
            orderStartTime: new Date(getOrderStartTime(orderLogsResult.logs)).toISOString(),
            earliestLoanApplicationLogAt: new Date(
              Math.min(
                ...loanApplicationResult.logs
                  .map(getCreatedAtTime)
                  .filter(Number.isFinite)
              )
            ).toISOString()
          });
        } else if (loanApplicationDiscardDecision.reason === 'mismatched_top_level_order_id') {
          logger.warn('Discarding full LAID log set because at least one top-level order_id belongs to a different order', {
            merchantId,
            orderId,
            loanApplicationId,
            topLevelOrderIds: loanApplicationDiscardDecision.topLevelOrderIds
          });
        }

        discardedLoanApplicationIds.push(loanApplicationId);
      } else {
        sourceResults.push(loanApplicationResult);
        if (loanApplicationResult.success) {
          preservedLoanApplicationIds.push(loanApplicationId);
        }
      }
      await this.sleep(this.delayBetweenRequests);
    }

    const successfulSourceResults = sourceResults.filter(result => result.success);
    const allLogs = dedupeLogs(
      successfulSourceResults
        .flatMap(result => result.logs)
        .sort(compareLogsForReplay)
    );

    const sourceCounts = buildSourceCounts(sourceResults);

    logger.info(`Successfully fetched combined replay logs for order ${orderId}`, {
      merchantId,
      orderId,
      customerId: replayContext.customerId,
      loanApplicationIds: replayContext.loanApplicationIds,
      preservedLoanApplicationIds,
      discardedLoanApplicationIds,
      sourceCounts,
      combinedLogCount: allLogs.length
    });

    return {
      success: successfulSourceResults.length > 0 && allLogs.length > 0,
      logs: allLogs,
      count: allLogs.length,
      merchantId,
      orderId,
      context: {
        ...replayContext,
        loanApplicationIds: preservedLoanApplicationIds
      },
      sourceCounts,
      sourceResults
    };
  }

  async fetchLogsForOrders(orderList) {
    if (!Array.isArray(orderList) || orderList.length === 0) {
      logger.error('No orders provided to fetch');
      return {
        success: false,
        allLogs: [],
        stats: { total: 0, successful: 0, failed: 0, totalLogs: 0 },
        error: 'No orders provided'
      };
    }

    if (!this.sessionToken) {
      logger.error('Session token not provided');
      return {
        success: false,
        allLogs: [],
        stats: { total: 0, successful: 0, failed: 0, totalLogs: 0 },
        error: 'Session token not provided'
      };
    }

    const results = [];
    let successfulFetches = 0;
    let failedFetches = 0;
    let totalLogCount = 0;

    for (let i = 0; i < orderList.length; i++) {
      const { merchantId, orderId } = orderList[i];
      const result = await this.fetchLogsForOrder(merchantId, orderId);
      results.push(result);

      if (result.success) {
        successfulFetches += 1;
        totalLogCount += result.count;
      } else {
        failedFetches += 1;
      }

      if (i < orderList.length - 1) {
        await this.sleep(this.delayBetweenRequests);
      }
    }

    const allLogs = dedupeLogs(results.filter(result => result.success).flatMap(result => result.logs))
      .sort(compareLogsForReplay);
    const saved = await this.saveLogsToFile(allLogs);

    return {
      success: failedFetches === 0,
      allLogs,
      stats: {
        total: orderList.length,
        successful: successfulFetches,
        failed: failedFetches,
        totalLogs: totalLogCount
      },
      results,
      saved,
      outputPath: this.outputPath
    };
  }

  async saveLogsToFile(logs) {
    try {
      const outputDir = dirname(this.outputPath);
      await mkdir(outputDir, { recursive: true });
      const absolutePath = resolve(process.cwd(), this.outputPath);
      await writeFile(absolutePath, JSON.stringify(logs, null, 2), 'utf-8');
      logger.info(`Saved ${logs.length} logs to ${this.outputPath}`);
      return true;
    } catch (error) {
      logger.error(`Failed to save logs to file: ${error.message}`);
      return false;
    }
  }

  sleep(ms) {
    return new Promise(resolvePromise => setTimeout(resolvePromise, ms));
  }
}
