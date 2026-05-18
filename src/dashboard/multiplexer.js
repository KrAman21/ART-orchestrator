import express from 'express';
import { createServer as createHttpServer } from 'http';
import { logger } from '../utils/logger.js';
import { getApiMapping } from '../config.js';
import { setupUnixSocket, configureSocketPermissions } from '../utils/socket-utils.js';
import SessionOrchestratorRegistry from './session-registry.js';

const MULTIPLEXER_PORT = parseInt(process.env.MULTIPLEXER_PORT || process.env.PORT || '3001', 10);
const MULTIPLEXER_UNIX_SOCKET = process.env.MULTIPLEXER_UNIX_SOCKET || null;

export function createMultiplexerServer() {
  const app = express();
  const registry = new SessionOrchestratorRegistry();

  app.use(express.json({ limit: '10mb' }));
  app.use(express.urlencoded({ extended: true }));

  app.use((req, _res, next) => {
    logger.debug('Multiplexer incoming request', {
      method: req.method,
      path: req.path,
      activeSessions: registry.getActiveCount()
    });
    next();
  });

  app.get('/health', (_req, res) => {
    res.json({
      status: 'healthy',
      timestamp: new Date().toISOString(),
      activeSessions: registry.getActiveCount(),
      sessions: registry.getAllSessions()
    });
  });

  app.get('/status', (_req, res) => {
    res.json({
      activeSessions: registry.getActiveCount(),
      sessions: registry.getAllSessions()
    });
  });

  app.use('/:api(*)', async (req, res) => {
    const api = '/' + req.params.api;
    const mapping = getApiMapping(api);

    if (!mapping) {
      logger.info(`Ignoring unmapped API endpoint (webhook): ${api}`);
      return res.json({ success: true, ignored: true, message: 'Webhook ignored' });
    }

    const payload = req.body;
    const loanApplicationId = payload?.loan_application_id;
    const lenderOrgId = payload?.lender_org_id ||
                         payload?.themisDetail?.lenderOrgId ||
                         payload?.lenderOrgId ||
                         req.headers['x-lender-org-id'] ||
                         req.headers['X-Lender-Org-Id'];

    const orchestrator = registry.findOrchestrator(payload);

    if (!orchestrator || !orchestrator.isRunning) {
      logger.warn('No active orchestrator found for request', {
        api,
        loanApplicationId,
        lenderOrgId,
        activeSessions: registry.getActiveCount()
      });
      return res.status(503).json({
        success: false,
        error: 'No active ART session available for this request'
      });
    }

    const parts = mapping.sourceDestination.split('_');
    const source = parts[0];
    const destination = parts[1];
    const logTag = mapping.logTag;
    const requestId = req.headers['x-request-id'] || req.body.request_id;

    try {
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

      if (result.headers) {
        Object.entries(result.headers).forEach(([key, value]) => {
          res.setHeader(key, value);
        });
      }

      res.json(result.payload || result);
    } catch (error) {
      logger.error('Multiplexer route error', { error: error.message, api, source, destination });
      res.status(500).json({
        success: false,
        error: error.message
      });
    }
  });

  return { app, registry };
}

export function startMultiplexerServer(port = MULTIPLEXER_PORT) {
  const { app, registry } = createMultiplexerServer();

  if (port > 0) {
    createHttpServer(app).listen(port, () => {
      logger.info(`Multiplexer orchestrator server running on TCP port ${port}`);
      console.log(`🔀 Orchestrator TCP: http://localhost:${port}/`);
    });
  }

  if (MULTIPLEXER_UNIX_SOCKET) {
    setupUnixSocket(MULTIPLEXER_UNIX_SOCKET);
    createHttpServer(app).listen(MULTIPLEXER_UNIX_SOCKET, () => {
      configureSocketPermissions(MULTIPLEXER_UNIX_SOCKET);
      logger.info(`Multiplexer orchestrator server running on Unix socket ${MULTIPLEXER_UNIX_SOCKET}`);
      console.log(`🔀 Orchestrator Unix socket: ${MULTIPLEXER_UNIX_SOCKET}`);
    });
  }

  return new Promise((resolve) => {
    resolve({ server: null, registry });
  });
}

export { SessionOrchestratorRegistry };
