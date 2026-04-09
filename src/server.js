import express from 'express';
import { logger } from './utils/logger.js';
import { getApiMapping } from './config.js';

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
    // console.log(`Received request on ${req.path} with body:`, req.body);
    try {
      const api = '/' + req.params.api;
      console.log(`Handling API: ${api}`);
      const payload = req.body;
      const requestId = req.headers['x-request-id'] || req.body.request_id;

      // Determine source/destination and logTag from API endpoint mapping
      const mapping = getApiMapping(api);
      if (!mapping) {
        // Unknown API endpoint - likely a webhook/callback, ignore gracefully
        logger.info(`Ignoring unmapped API endpoint (webhook): ${api}`);
        return res.json({ success: true, ignored: true, message: 'Webhook ignored' });
      }

      // Source/destination always from mapping
      const parts = mapping.sourceDestination.split('_');
      const source = parts[0];
      const destination = parts[1];
      const logTag = mapping.logTag;

      console.log('Request headers: ', req.headers);

      // Extract correlation fields from payload for matching
      const loanApplicationId = payload?.loan_application_id;
      const lenderOrgId = payload?.lender_org_id;

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
