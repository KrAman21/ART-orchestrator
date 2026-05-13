import { logger } from '../utils/logger.js';
import { runSequentialArt } from '../sequential-runner.js';
import { MOCKS_ENABLED, QAPI_CONFIG } from '../config.js';

export async function getOrdersToProcess(merchantId, orderList, lastMinutes, sseManager) {
  const orders = [];

  if (orderList && orderList.length > 0) {
    for (const orderId of orderList) {
      orders.push({ merchantId, orderId });
    }
  } else if (lastMinutes) {
    const endDate = new Date();
    const startDate = new Date(endDate.getTime() - lastMinutes * 60 * 1000);
    sseManager.broadcast('INFO', `Fetching orders from last ${lastMinutes} minutes...`);
    const orderIds = await fetchRecentOrderIds(merchantId, startDate, endDate);
    for (const orderId of orderIds) {
      orders.push({ merchantId, orderId });
    }
  }

  return orders;
}

export async function fetchRecentOrderIds(merchantId, startDate, endDate) {
  if (!QAPI_CONFIG.token) {
    logger.warn('QAPI_TOKEN not configured, skipping order fetch from QAPI');
    return [];
  }

  const { fetchOrderIdsFromQAPI } = await import('../services/http-client.js');

  try {
    const result = await fetchOrderIdsFromQAPI(
      startDate.toISOString(),
      endDate.toISOString(),
      [merchantId]
    );

    if (result.success && result.orders) {
      return result.orders.map(o => o.orderId);
    }

    logger.warn('Failed to fetch order IDs from QAPI', { error: result.error });
    return [];
  } catch (error) {
    logger.error('Error fetching order IDs from QAPI', { error: error.message });
    return [];
  }
}

export async function runArtProcess(merchantId, orders, server) {
  const { sseManager } = server;
  const stopSignal = { requested: false };
  server.artStopSignal = stopSignal;

  const boundInfo = logger.info.bind(logger);
  const boundWarn = logger.warn.bind(logger);
  const boundError = logger.error.bind(logger);

  logger.info = (...args) => {
    sseManager.broadcastRaw('INFO', typeof args[0] === 'string' ? args[0] : JSON.stringify(args[0]));
    return boundInfo(...args);
  };
  logger.warn = (...args) => {
    sseManager.broadcastRaw('WARN', typeof args[0] === 'string' ? args[0] : JSON.stringify(args[0]));
    return boundWarn(...args);
  };
  logger.error = (...args) => {
    sseManager.broadcastRaw('ERROR', typeof args[0] === 'string' ? args[0] : JSON.stringify(args[0]));
    return boundError(...args);
  };

  try {
    const config = {
      MAX_JOURNEY_TIME_MS: 3 * 60 * 1000,
      REPORT_PATH: 'report.json',
      AUTO_FETCH_LOGS: true,
      USE_ASYNC_ORCHESTRATOR: true,
      PORT: process.env.PORT || 3001,
      TIMEOUT_MS: 10000,
      LOGS_FILE_PATH: 'data/logs.json',
      MERCHANT_ID: merchantId,
      SESSION_TOKEN: process.env.SESSION_TOKEN || '',
      ENABLE_MOCKS: MOCKS_ENABLED,
      stopSignal
    };

    const result = await runSequentialArt(orders, config);

    const wasStopped = stopSignal.requested;
    sseManager.broadcast('INFO', wasStopped
      ? 'ART stopped by user. Report has been saved.'
      : `ART completed. Successful: ${result.success}`
    );

    if (result.results) {
      const successCount = result.results.filter(r => r.success).length;
      const failCount = result.results.filter(r => !r.success).length;
      sseManager.broadcast('INFO', `Results: ${successCount} succeeded, ${failCount} failed`);
    }

    sseManager.broadcastReportReady();

  } catch (error) {
    sseManager.broadcast('ERROR', `ART failed: ${error.message}`);
    boundError('ART process failed', { error: error.message, stack: error.stack });
    sseManager.broadcastReportReady();
  } finally {
    logger.info = boundInfo;
    logger.warn = boundWarn;
    logger.error = boundError;
    server.isRunning = false;
    server.artStopSignal = null;
  }
}
