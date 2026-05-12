import { writeFile, mkdir } from 'fs/promises';
import { dirname, resolve } from 'path';
import { fetchS3TraceLogs } from './s3-trace-logs-client.js';
import { logger } from '../utils/logger.js';

export class BatchLogFetcher {
  constructor(options = {}) {
    this.sessionToken = options.sessionToken || process.env.SESSION_TOKEN || '';
    this.outputPath = options.outputPath || 'logs/s3-fetched-logs/logs.json';
    this.delayBetweenRequests = options.delayBetweenRequests || 500;
    this.maxRetries = options.maxRetries || 3;
    this.retryDelay = options.retryDelay || 2000;
    this.batchSize = options.batchSize || 1;
  }

  async fetchLogsForOrder(merchantId, orderId, retries = 0) {
    logger.info(`Fetching logs for order: ${merchantId}/${orderId}`, {
      merchantId,
      orderId,
      attempt: retries + 1
    });

    const result = await fetchS3TraceLogs(merchantId, orderId, this.sessionToken);

    if (result.success) {
      logger.info(`Successfully fetched ${result.count} logs for order ${orderId}`);
      return {
        success: true,
        logs: result.logs || [],
        count: result.count,
        merchantId,
        orderId
      };
    }

    if (retries < this.maxRetries) {
      logger.warn(`Fetch failed for order ${orderId}, retrying (${retries + 1}/${this.maxRetries})...`, {
        error: result.error
      });
      await this.sleep(this.retryDelay * (retries + 1));
      return this.fetchLogsForOrder(merchantId, orderId, retries + 1);
    }

    logger.error(`Failed to fetch logs for order ${orderId} after ${this.maxRetries} attempts`, {
      error: result.error
    });

    return {
      success: false,
      error: result.error,
      logs: [],
      count: 0,
      merchantId,
      orderId
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

    logger.info(`Starting batch fetch for ${orderList.length} orders`);

    const results = [];
    let successfulFetches = 0;
    let failedFetches = 0;
    let totalLogCount = 0;

    for (let i = 0; i < orderList.length; i++) {
      const { merchantId, orderId } = orderList[i];
      
      logger.info(`Processing order ${i + 1}/${orderList.length}: ${merchantId}/${orderId}`);

      const result = await this.fetchLogsForOrder(merchantId, orderId);
      results.push(result);

      if (result.success) {
        successfulFetches++;
        totalLogCount += result.count;
      } else {
        failedFetches++;
      }

      if (i < orderList.length - 1) {
        logger.info(`Waiting ${this.delayBetweenRequests}ms before next request...`);
        await this.sleep(this.delayBetweenRequests);
      }
    }

    const allLogs = results
      .filter(r => r.success)
      .flatMap(r => r.logs);

    const stats = {
      total: orderList.length,
      successful: successfulFetches,
      failed: failedFetches,
      totalLogs: totalLogCount
    };

    logger.info('Batch fetch completed', stats);

    const saved = await this.saveLogsToFile(allLogs);

    return {
      success: failedFetches === 0,
      allLogs,
      stats,
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
    return new Promise(resolve => setTimeout(resolve, ms));
  }

  static createOrderList(merchantId, orderIds) {
    return orderIds.map(orderId => ({
      merchantId,
      orderId
    }));
  }

  static createOrderListWithDefaults(orders, defaultMerchantId = 'flipkart') {
    return orders.map(order => ({
      merchantId: order.merchantId || defaultMerchantId,
      orderId: order.orderId
    }));
  }
}

export async function fetchLogsForOrders(orderList, options = {}) {
  const fetcher = new BatchLogFetcher(options);
  return fetcher.fetchLogsForOrders(orderList);
}

export default BatchLogFetcher;
