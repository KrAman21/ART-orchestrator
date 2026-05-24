import { logger, subscribe, unsubscribe, runInSession } from '../utils/logger.js';
import { runSequentialArt } from '../sequential-runner.js';
import { MOCKS_ENABLED, QAPI_CONFIG } from '../config.js';

export async function getOrdersToProcess(merchantId, orderList, lastMinutes, sseManager) {
  const orders = [];

  if (orderList && orderList.length > 0) {
    for (const orderId of orderList) {
      orders.push({ merchantId, orderId });
    }
  } else if (lastMinutes) {
      const LOG_DELAY_MINUTES = 5;
      const endDate = new Date(Date.now() - LOG_DELAY_MINUTES * 60 * 1000);
      const startDate = new Date(endDate.getTime() - lastMinutes * 60 * 1000);
      sseManager.broadcast('INFO', `Fetching orders from last ${lastMinutes} minutes (with ${LOG_DELAY_MINUTES}min log delay offset)...`);
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

export async function runArtProcess(merchantId, orders, server, session) {
  const sseManager = session.sseManager;
  const mySessionId = session.sessionId;
  const stopSignal = { requested: false };
  session.artStopSignal = stopSignal;

  const subId = subscribe((level, message, _meta, logSessionId) => {
    if (logSessionId === mySessionId) {
      sseManager.broadcastRaw(level, typeof message === 'string' ? message : JSON.stringify(message));
    }
  });

  try {
    const config = {
      MAX_JOURNEY_TIME_MS: 3 * 60 * 1000,
      REPORT_PATH: session.reportPath || 'report.json',
      AUTO_FETCH_LOGS: true,
      USE_ASYNC_ORCHESTRATOR: true,
      PORT: server.orchestratorPort || 3001,
      TIMEOUT_MS: 10000,
      LOGS_FILE_PATH: `data/logs-${mySessionId}.json`,
      MERCHANT_ID: merchantId,
      SESSION_TOKEN: process.env.SESSION_TOKEN || '',
      ENABLE_MOCKS: MOCKS_ENABLED,
      PARALLEL_ORDERS: 10,
      KEEP_ORDER_TEMP_FILES: process.env.KEEP_ORDER_TEMP_FILES === 'true',
      stopSignal,
      sessionId: mySessionId,
      registry: server.registry,
      getRegistrySessionId: (orderId) => `${mySessionId}:${orderId}`,
      onOrchestratorReady: (orchestrator, orderId, registrySessionId) => {
        if (server.registry) {
          server.registry.register(registrySessionId, orchestrator, [orderId]);
        }
      },
      onLoanApplicationId: (loanApplicationId, orderId, registrySessionId) => {
        if (server.registry) {
          server.registry.addLoanApplicationId(registrySessionId, loanApplicationId);
        }
      }
    };

    const result = await runInSession(mySessionId, () => runSequentialArt(orders, config));

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
    logger.error('ART process failed', { error: error.message, stack: error.stack, sessionId: mySessionId });
    sseManager.broadcastReportReady();
  } finally {
    unsubscribe(subId);
    if (server.registry) {
      server.registry.unregister(mySessionId);
    }
    session.isRunning = false;
    session.artStopSignal = null;
  }
}
