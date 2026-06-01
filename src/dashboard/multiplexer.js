import express from 'express';
import { createServer as createHttpServer } from 'http';
import { logger } from '../utils/logger.js';
import { getApiMapping } from '../config.js';
import { setupUnixSocket, configureSocketPermissions } from '../utils/socket-utils.js';
import SessionOrchestratorRegistry from './session-registry.js';

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
    const mapping = getApiMapping(api, { payload: req.body, headers: req.headers });

    if (!mapping) {
      logger.info(`Ignoring unmapped API endpoint (webhook): ${api}`);
      return res.json({ success: true, ignored: true, message: 'Webhook ignored' });
    }

    const payload = req.body;
    const loanApplicationId = payload?.loan_application_id || payload?.loanApplicationId || req.headers['x-loan-application-id'];
    const orderId = payload?.order_id || payload?.orderId || req.headers['x-order-id'];
    const lenderOrgId = payload?.lender_org_id ||
                         payload?.themisDetail?.lenderOrgId ||
                         payload?.lenderOrgId ||
                         req.headers['x-lender-org-id'] ||
                         req.headers['X-Lender-Org-Id'];

    const orchestrator = registry.findOrchestrator(payload, req.headers);

    if (api === '/v1.0/fetchOfferResponse') {
      logger.info('FETCH_OFFER_ASYNC callback routing', {
        api,
        loanApplicationId,
        orderId,
        lenderOrgId,
        activeSessions: registry.getActiveCount(),
        matchedSessionRunning: !!(orchestrator && orchestrator.isRunning),
        registeredSessions: registry.getAllSessions()
      });
    }

    if (!orchestrator || !orchestrator.isRunning) {
      logger.warn('No active orchestrator found for request', {
        api,
        loanApplicationId,
        orderId,
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

export function startMultiplexerServer() {
  const { app, registry } = createMultiplexerServer();
  let unixServer = null;

  const readyPromises = [];

  if (MULTIPLEXER_UNIX_SOCKET) {
    try {
      setupUnixSocket(MULTIPLEXER_UNIX_SOCKET);
      logger.info('Prepared multiplexer unix socket path', {
        socketPath: MULTIPLEXER_UNIX_SOCKET
      });

      unixServer = createHttpServer(app);
      readyPromises.push(new Promise((resolve, reject) => {
        unixServer.once('error', reject);
        unixServer.listen(MULTIPLEXER_UNIX_SOCKET, () => {
          configureSocketPermissions(MULTIPLEXER_UNIX_SOCKET);
          logger.info('ART multiplexer listening on unix socket', {
            socketPath: MULTIPLEXER_UNIX_SOCKET
          });
          unixServer.off('error', reject);
          resolve();
        });
      }));
      unixServer.on('error', (error) => {
        logger.error('ART multiplexer unix socket server error', {
          socketPath: MULTIPLEXER_UNIX_SOCKET,
          error: error.message
        });
      });
  } catch (error) {
      logger.error('Failed to prepare multiplexer unix socket', { error: error.message });
    }
  }

  if (!MULTIPLEXER_UNIX_SOCKET) {
    throw new Error('MULTIPLEXER_UNIX_SOCKET is required. ART no longer supports TCP port listeners.');
  }

  return {
    unixServer,
    registry,
    ready: Promise.all(readyPromises).then(() => undefined)
  };
}
