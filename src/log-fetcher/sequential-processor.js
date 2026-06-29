import { BatchLogFetcher } from './batch-processor.js';
import { logger } from '../utils/logger.js';

export class SequentialLogProcessor {
  constructor(options = {}) {
    this.sessionToken = options.sessionToken || process.env.SESSION_TOKEN || '';
    this.outputPath = options.outputPath || 'data/logs.json';
    this.delayBetweenRequests = options.delayBetweenRequests || 500;
    this.maxRetries = options.maxRetries || 3;
    this.onLogsFetched = options.onLogsFetched || null;
    this.onOrderComplete = options.onOrderComplete || null;
  }

  async processOrders(orderList) {
    if (!Array.isArray(orderList) || orderList.length === 0) {
      logger.error('No orders provided to process');
      return {
        success: false,
        totalOrders: 0,
        completedOrders: 0,
        failedOrders: 0,
        error: 'No orders provided'
      };
    }

    if (!this.sessionToken) {
      logger.error('Session token not provided');
      return {
        success: false,
        totalOrders: 0,
        completedOrders: 0,
        failedOrders: 0,
        error: 'Session token not provided'
      };
    }

    logger.info(`Starting sequential processing for ${orderList.length} orders`);

    const results = [];
    let completedOrders = 0;
    let failedOrders = 0;

    const fetcher = new BatchLogFetcher({
      sessionToken: this.sessionToken,
      outputPath: this.outputPath,
      delayBetweenRequests: this.delayBetweenRequests,
      maxRetries: this.maxRetries
    });

    for (let i = 0; i < orderList.length; i++) {
      const { merchantId, orderId } = orderList[i];
      
      logger.info(`\n========================================`);
      logger.info(`Processing order ${i + 1}/${orderList.length}: ${merchantId}/${orderId}`);
      logger.info(`========================================\n`);

      try {
        const singleOrderList = [{ merchantId, orderId }];
        const fetchResult = await fetcher.fetchLogsForOrders(singleOrderList);
        const orderFetchResult = fetchResult.results?.[0] || null;

        if (orderFetchResult?.skipped) {
          completedOrders++;
          results.push({
            orderIndex: i + 1,
            merchantId,
            orderId,
            success: true,
            skipped: true,
            skipReason: orderFetchResult.skipReason
          });
          logger.warn(`Skipping order ${orderId} due to order-context multi-LAID guard`, {
            skipReason: orderFetchResult.skipReason
          });
          continue;
        }

        if (!fetchResult.success || fetchResult.stats.totalLogs === 0) {
          logger.error(`Failed to fetch logs for order ${orderId}`, {
            error: fetchResult.error || 'No logs returned'
          });
          failedOrders++;
          results.push({
            orderIndex: i + 1,
            merchantId,
            orderId,
            success: false,
            error: fetchResult.error || 'No logs returned'
          });
          continue;
        }

        logger.info(`Successfully fetched ${fetchResult.stats.totalLogs} logs for order ${orderId}`);

        if (this.onLogsFetched) {
          logger.info(`Triggering ART for order ${orderId}...`);
          const artResult = await this.onLogsFetched({
            orderIndex: i + 1,
            totalOrders: orderList.length,
            merchantId,
            orderId,
            logCount: fetchResult.stats.totalLogs,
            outputPath: this.outputPath
          });

          results.push({
            orderIndex: i + 1,
            merchantId,
            orderId,
            success: true,
            logsFetched: fetchResult.stats.totalLogs,
            artCompleted: artResult?.success || false,
            artResult
          });

          if (artResult?.success) {
            completedOrders++;
            logger.info(`ART completed successfully for order ${orderId}`);
          } else {
            failedOrders++;
            logger.error(`ART failed for order ${orderId}`);
          }

          if (this.onOrderComplete) {
            await this.onOrderComplete({
              orderIndex: i + 1,
              totalOrders: orderList.length,
              merchantId,
              orderId,
              success: artResult?.success || false
            });
          }
        } else {
          completedOrders++;
          results.push({
            orderIndex: i + 1,
            merchantId,
            orderId,
            success: true,
            logsFetched: fetchResult.stats.totalLogs
          });
        }

      } catch (error) {
        logger.error(`Exception processing order ${orderId}:`, error);
        failedOrders++;
        results.push({
          orderIndex: i + 1,
          merchantId,
          orderId,
          success: false,
          error: error.message
        });
      }

      if (i < orderList.length - 1) {
        logger.info(`Moving to next order in 2 seconds...`);
        await this.sleep(2000);
      }
    }

    logger.info(`\n========================================`);
    logger.info(`Sequential Processing Complete`);
    logger.info(`========================================`);
    logger.info(`Total Orders:   ${orderList.length}`);
    logger.info(`Completed:      ${completedOrders}`);
    logger.info(`Failed:         ${failedOrders}`);
    logger.info(`========================================\n`);

    return {
      success: failedOrders === 0,
      totalOrders: orderList.length,
      completedOrders,
      failedOrders,
      results
    };
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
}

export async function processOrdersSequentially(orderList, options = {}) {
  const processor = new SequentialLogProcessor(options);
  return processor.processOrders(orderList);
}

export default SequentialLogProcessor;
