import express from 'express';
import { logger } from './utils/logger.js';
import { getLogTagForApi, getApiMapping } from './config.js';

/**
 * Create Express server with routes for LSP and GW
 *
 * Routes are organized by source service:
 * - /lsp/* - Routes that LSP calls (LSP -> GW flows)
 * - /gw/* - Routes that GW calls (GW -> LSP flows)
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

  // ============================================
  // LSP Routes (LSP calls these endpoints)
  // These represent LSP -> GW flows
  // ============================================

  const lspRouter = express.Router();

  // Generic LSP request handler
  lspRouter.use('/:api(*)', async (req, res) => {
    try {
      const api = '/' + req.params.api;
      const payload = req.body;
      const requestId = req.headers['x-request-id'] || req.body.request_id;

      // Determine logTag based on API endpoint (from config mapping)
      const mapping = getApiMapping(api);
      const logTag = mapping?.logTag;

      const result = await orchestrator.handleIncomingRequest({
        source: 'LSP',
        destination: 'GW',
        api,
        payload,
        requestId,
        logTag,
        headers: req.headers
      });

      if (result.success === false) {
        return res.status(400).json(result);
      }

      res.json(result.payload || result);

    } catch (error) {
      logger.error('LSP route error', { error: error.message, stack: error.stack });
      res.status(500).json({
        success: false,
        error: error.message
      });
    }
  });

  app.use('/lsp', lspRouter);

  // ============================================
  // GW Routes (GW calls these endpoints)
  // These represent GW -> LSP flows
  // ============================================

  const gwRouter = express.Router();

  // Generic GW request handler
  gwRouter.use('/:api(*)', async (req, res) => {
    try {
      const api = '/' + req.params.api;
      const payload = req.body;
      const requestId = req.headers['x-request-id'] || req.body.request_id;

      // Determine logTag based on API endpoint
      const mapping = getApiMapping(api);
      const logTag = mapping?.logTag;

      const result = await orchestrator.handleIncomingRequest({
        source: 'GW',
        destination: 'LSP',
        api,
        payload,
        requestId,
        logTag,
        headers: req.headers
      });

      if (result.success === false) {
        return res.status(400).json(result);
      }

      res.json(result.payload || result);

    } catch (error) {
      logger.error('GW route error', { error: error.message, stack: error.stack });
      res.status(500).json({
        success: false,
        error: error.message
      });
    }
  });

  app.use('/gw', gwRouter);

  // ============================================
  // Webhook Routes (External -> GW flows)
  // These handle LENDER callbacks and webhooks
  // ============================================

  const webhookRouter = express.Router();

  webhookRouter.post('/lender/:lenderId', async (req, res) => {
    try {
      const lenderId = req.params.lenderId;
      const payload = req.body;

      logger.info('Received lender webhook', { lenderId });

      // This represents LENDER -> GW flow
      // We need to inject this into the log sequence
      const result = await orchestrator.handleIncomingRequest({
        source: 'LENDER',
        destination: 'GW',
        api: '/webhook/lender/' + lenderId,
        payload,
        requestId: req.headers['x-request-id'],
        logTag: 'LENDER_CALLBACK',
        headers: req.headers
      });

      if (result.success === false) {
        return res.status(400).json(result);
      }

      res.json(result.payload || { received: true });

    } catch (error) {
      logger.error('Webhook error', { error: error.message });
      res.status(500).json({
        success: false,
        error: error.message
      });
    }
  });

  app.use('/webhook', webhookRouter);

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
