import express from 'express';
import { logger } from './utils/logger.js';
import { getApiMapping, QAPI_CONFIG } from './config.js';
import { fetchOrderIdsFromQAPI } from './services/http-client.js';
import { writeFile } from 'fs/promises';
import { resolve } from 'path';
import { MultiSourceLogFetcher } from './log-fetcher/multi-source-log-fetcher.js';

/**
 * Create Express server with routes for LSP and GW
 *
 * Routes are organized by source service:
 * - /lsp/* - Routes that LSP calls (LSP -> GW flows)
 * - /gw/* - Routes that GW calls (GW -> LSP flows)
 * - /webhook/* - External service callbacks
 */
export function createServer(orchestrator) {
  const app = express();

  // Middleware
  app.use(express.json({ limit: '10mb' }));
  app.use(express.urlencoded({ extended: true }));

  // Request logging middleware
  app.use((req, _res, next) => {
    logger.debug('Incoming request', {
      method: req.method,
      path: req.path,
      headers: req.headers['x-request-id']
    });
    next();
  });

  // Health check
  app.get('/health', (_req, res) => {
    res.json({
      status: 'healthy',
      timestamp: new Date().toISOString(),
      orchestrator: {
        running: orchestrator.isRunning,
        progress: orchestrator.validator?.getProgress()
      }
    });
  });

  // Status endpoint - get current replay state
  app.get('/status', (_req, res) => {
    res.json(orchestrator.getResults());
  });

  /**
   * Unified request handler for all service routes
   * Derives source/destination entirely from API mapping
   * @returns {Function} Express handler
   */
  const unifiedHandler = () => async (req, res) => {
    console.log(`Received request on ${req.path} with body:`, req.body);
    try {
      const api = '/' + req.params.api;
      console.log(`Handling API: ${api}`);
      const payload = req.body;
      const requestId = req.headers['x-request-id'] || req.body.request_id || req.body.requestId;
      const nextExpectedEntry = orchestrator.validator?.entries?.[orchestrator.validator?.currentIndex] || null;
      const lookaheadLogTags = orchestrator.validator?.entries
        ?.slice(orchestrator.validator?.currentIndex || 0, (orchestrator.validator?.currentIndex || 0) + 8)
        ?.map(entry => entry?.logTag)
        ?.filter(Boolean) || [];
      const lookaheadEntries = orchestrator.validator?.entries
        ?.slice(orchestrator.validator?.currentIndex || 0, (orchestrator.validator?.currentIndex || 0) + 8)
        ?.map(entry => ({ logTag: entry?.logTag, index: entry?.index }))
        ?.filter(entry => entry?.logTag) || [];
      

      // Determine source/destination and logTag from API endpoint mapping
      const mapping = getApiMapping(api, {
        payload: req.body,
        headers: req.headers,
        nextExpectedLogTag: nextExpectedEntry?.logTag || null,
        lookaheadLogTags,
        lookaheadEntries,
        currentReplayIndex: orchestrator.validator?.currentIndex || 0,
        replayScopeKey: orchestrator.config?.registrySessionId || orchestrator.orderId || 'single-server'
      });
      if (!mapping) {
        // Unknown API endpoint - likely a webhook/callback, ignore gracefully
        logger.info(`Ignoring unmapped API endpoint (webhook): ${api}`);
        return res.json('Webhook ignored');
      }

      // Source/destination always from mapping
      const parts = mapping.sourceDestination.split('_');
      const source = parts[0];
      const destination = parts[1];
      const logTag = mapping.logTag;

      // console.log('Request headers: ', req.headers);
      
      // Log incoming request details
      logger.info(`=== INCOMING REQUEST FROM ${source} ===`, {
        path: req.path,
        api: api,
        source: source,
        destination: destination,
        logTag: logTag,
        headers: {
          'x-request-id': req.headers['x-request-id'],
          'x-art-callback-url': req.headers['x-art-callback-url'],
          'x-art-enabled': req.headers['x-art-enabled'],
          'content-type': req.headers['content-type'],
          'x-loan-application-id': req.headers['x-loan-application-id'],
          'x-merchant-id': req.headers['x-merchant-id']
        },
        bodyKeys: Object.keys(payload || {}),
        timestamp: new Date().toISOString()
      });

      // Extract correlation fields from payload for matching
      const loanApplicationId = payload?.loan_application_id || payload?.loanApplicationId || req.headers['x-loan-application-id'];
      // lender_org_id can be at top level, nested in themisDetail, or in headers
      const lenderOrgId = payload?.lender_org_id ||
                          payload?.themisDetail?.lenderOrgId ||
                          payload?.lenderOrgId ||
                          req.headers['x-lender-org-id'] ||
                          req.headers['X-Lender-Org-Id'];

      if (api === '/v1.0/fetchOfferResponse') {
        logger.info('FETCH_OFFER_ASYNC callback received on direct server', {
          api,
          requestId,
          loanApplicationId,
          lenderOrgId,
          hasOrchestrator: !!orchestrator,
          isRunning: !!orchestrator?.isRunning
        });
      }

      const result = await orchestrator.handleIncomingRequest({
        source,
        destination,
        api,
        payload,
        requestId,
        logTag,
        headers: req.headers,
        loanApplicationId,
        lenderOrgId
      });

      if (result.success === false) {
        return res.status(400).json(result);
      }

      // Forward response headers if present
      if (result.headers) {
        Object.entries(result.headers).forEach(([key, value]) => {
          res.setHeader(key, value);
        });
      }

      res.json(result.payload || result);

    } catch (error) {
      logger.error(`Route error`, { error: error.message, stack: error.stack });
      res.status(500).json({
        success: false,
        error: error.message
      });
    }
  };

  // ============================================
  // Single Catch-all Route - handles all API calls
  // Source/destination derived from API mapping in config
  // ============================================

  app.use('/:api(*)', unifiedHandler());

  // ============================================
  // Control Routes
  // ============================================

  // Start replay
  app.post('/control/start', async (_req, res) => {
    try {
      await orchestrator.start();
      res.json({
        success: true,
        message: 'Orchestrator started',
        progress: orchestrator.validator?.getProgress()
      });
    } catch (error) {
      res.status(500).json({
        success: false,
        error: error.message
      });
    }
  });

  // Stop replay
  app.post('/control/stop', async (_req, res) => {
    try {
      await orchestrator.stop();
      res.json({
        success: true,
        results: orchestrator.getResults()
      });
    } catch (error) {
      res.status(500).json({
        success: false,
        error: error.message
      });
    }
  });

  app.post('/api/fetch-logs', async (req, res) => {
    try {
      const { merchantId, orderId } = req.body;

      if (!merchantId || !orderId) {
        return res.status(400).json({
          success: false,
          error: 'Both merchantId and orderId are required'
        });
      }

      logger.info('Fetching logs from external API', { merchantId, orderId });

      const fetcher = new MultiSourceLogFetcher({
        sessionToken: process.env.SESSION_TOKEN,
        outputPath: 'data/logs.json'
      });
      const result = await fetcher.fetchLogsForOrder(merchantId, orderId);

      if (!result.success) {
        return res.status(500).json({
          success: false,
          error: result.error,
          message: result.message
        });
      }

      if (result.skipped) {
        logger.warn('Skipping log fetch replay for order due to order-context multi-LAID guard', {
          merchantId,
          orderId,
          skipReason: result.skipReason,
          context: result.context
        });

        return res.json({
          success: true,
          skipped: true,
          skipReason: result.skipReason,
          context: result.context,
          logCount: 0
        });
      }

      const logsFilePath = resolve(process.cwd(), 'data', 'logs.json');
      await writeFile(logsFilePath, JSON.stringify(result.logs, null, 2), 'utf-8');

      logger.info('Successfully fetched and saved logs', {
        merchantId,
        orderId,
        logCount: result.count,
        context: result.context,
        filePath: logsFilePath
      });

      res.json({
        success: true,
        message: 'Logs fetched and saved successfully',
        merchantId,
        orderId,
        logCount: result.count,
        filePath: 'data/logs.json'
      });

    } catch (error) {
      logger.error('Failed to fetch logs', { error: error.message, stack: error.stack });
      res.status(500).json({
        success: false,
        error: error.message
      });
    }
  });

  app.post('/api/fetch-order-ids', async (req, res) => {
    try {
      const { startDate, endDate } = req.body;

      if (!startDate || !endDate) {
        return res.status(400).json({
          success: false,
          error: 'Both startDate and endDate are required (ISO 8601 format)'
        });
      }

      logger.info('Fetching order IDs from QAPI', { startDate, endDate });

      const result = await fetchOrderIdsFromQAPI(startDate, endDate);

      if (!result.success) {
        return res.status(500).json({
          success: false,
          error: result.error,
          message: result.message
        });
      }

      res.json({
        success: true,
        message: 'Order IDs fetched successfully',
        orderCount: result.count,
        orderIds: result.orderIds,
        merchantId: QAPI_CONFIG.merchantId
      });

    } catch (error) {
      logger.error('Failed to fetch order IDs', { error: error.message, stack: error.stack });
      res.status(500).json({
        success: false,
        error: error.message
      });
    }
  });

  app.post('/api/run-art-for-orders', async (req, res) => {
    const results = {
      success: true,
      totalOrders: 0,
      processedOrders: 0,
      failedOrders: 0,
      errors: [],
      orderResults: []
    };

    try {
      const { startDate, endDate, maxOrders } = req.body;

      if (!startDate || !endDate) {
        return res.status(400).json({
          success: false,
          error: 'Both startDate and endDate are required (ISO 8601 format)'
        });
      }

      logger.info('Starting ART run for orders', { startDate, endDate, maxOrders });

      const orderResult = await fetchOrderIdsFromQAPI(startDate, endDate);

      if (!orderResult.success) {
        return res.status(500).json({
          success: false,
          error: 'Failed to fetch order IDs',
          message: orderResult.error
        });
      }

      let orderIds = orderResult.orderIds;
      results.totalOrders = orderIds.length;

      if (maxOrders && maxOrders > 0) {
        orderIds = orderIds.slice(0, maxOrders);
        logger.info(`Limiting to ${maxOrders} orders out of ${results.totalOrders}`);
      }

      logger.info(`Processing ${orderIds.length} orders`);

      for (let i = 0; i < orderIds.length; i++) {
        const orderId = orderIds[i];
        const orderResultItem = {
          orderId,
          status: 'pending',
          logsFetched: false,
          artStarted: false,
          error: null
        };

        try {
          logger.info(`[${i + 1}/${orderIds.length}] Processing order: ${orderId}`);

          const logsFetcher = new MultiSourceLogFetcher({
            sessionToken: process.env.SESSION_TOKEN,
            outputPath: 'data/logs.json'
          });
          const logsResult = await logsFetcher.fetchLogsForOrder(QAPI_CONFIG.merchantId, orderId);

          if (logsResult.skipped) {
            orderResultItem.status = 'skipped';
            orderResultItem.error = logsResult.skipReason;
            orderResultItem.skipped = true;
            results.orderResults.push(orderResultItem);
            logger.warn(`[${i + 1}/${orderIds.length}] Skipping order: ${orderId}`, {
              skipReason: logsResult.skipReason,
              context: logsResult.context
            });
            continue;
          }

          if (!logsResult.success) {
            orderResultItem.status = 'failed';
            orderResultItem.error = `Failed to fetch logs: ${logsResult.error}`;
            results.failedOrders++;
            results.errors.push({
              orderId,
              stage: 'fetch_logs',
              error: logsResult.error
            });
            results.orderResults.push(orderResultItem);
            continue;
          }

          orderResultItem.logsFetched = true;
          orderResultItem.logCount = logsResult.count;

          const logsFilePath = resolve(process.cwd(), 'data', 'logs.json');
          await writeFile(logsFilePath, JSON.stringify(logsResult.logs, null, 2), 'utf-8');

          logger.info(`[${i + 1}/${orderIds.length}] Logs saved for order: ${orderId}, count: ${logsResult.count}`);

          try {
            if (orchestrator.isRunning) {
              logger.info(`[${i + 1}/${orderIds.length}] Stopping orchestrator for previous order`);
              await orchestrator.stop();
            }

            const { fetchLogsFromJSONFile, filterAndSortLogs, filterOrchestratorSkippableLogs } = await import('./services/log-fetcher.js');
            const logs = await fetchLogsFromJSONFile('data/logs.json');
            const filteredLogs = await filterAndSortLogs(logs);
            const finalFilteredLogs = await filterOrchestratorSkippableLogs(filteredLogs);

            orchestrator.loadLogs(finalFilteredLogs);
            await orchestrator.start();

            orderResultItem.artStarted = true;
            results.processedOrders++;
            orderResultItem.status = 'success';
            logger.info(`[${i + 1}/${orderIds.length}] ART started for order: ${orderId}`);
          } catch (artError) {
            orderResultItem.status = 'failed';
            orderResultItem.error = `ART execution failed: ${artError.message}`;
            results.failedOrders++;
            results.errors.push({
              orderId,
              stage: 'art_execution',
              error: artError.message
            });
            logger.error(`[${i + 1}/${orderIds.length}] ART failed for order: ${orderId}`, {
              error: artError.message
            });
          }

        } catch (orderError) {
          orderResultItem.status = 'failed';
          orderResultItem.error = orderError.message;
          results.failedOrders++;
          results.errors.push({
            orderId,
            stage: 'processing',
            error: orderError.message
          });
          logger.error(`[${i + 1}/${orderIds.length}] Failed to process order: ${orderId}`, {
            error: orderError.message
          });
        }

        results.orderResults.push(orderResultItem);
      }

      results.success = results.failedOrders === 0;

      logger.info('ART run completed', {
        totalOrders: results.totalOrders,
        processed: results.processedOrders,
        failed: results.failedOrders
      });

      res.json(results);

    } catch (error) {
      logger.error('Failed to run ART for orders', { error: error.message, stack: error.stack });
      results.success = false;
      results.errors.push({
        stage: 'overall',
        error: error.message
      });
      res.status(500).json(results);
    }
  });

  // Error handling middleware
  app.use((err, req, res, _next) => {
    logger.error('Unhandled error', {
      error: err.message,
      stack: err.stack,
      path: req.path
    });
    res.status(500).json({
      success: false,
      error: 'Internal server error'
    });
  });

  return app;
}

export default createServer;
