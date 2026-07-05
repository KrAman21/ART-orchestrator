import express from 'express';
import { createServer as createHttpServer } from 'http';
import { logger } from '../utils/logger.js';
import { getApiMapping } from '../config.js';
import { setupUnixSocket, configureSocketPermissions } from '../utils/socket-utils.js';
import SessionOrchestratorRegistry, { extractRoutingIdentifiers } from './session-registry.js';

const MULTIPLEXER_UNIX_SOCKET = process.env.MULTIPLEXER_UNIX_SOCKET || null;

export function createMultiplexerServer() {
  const app = express();
  const registry = new SessionOrchestratorRegistry();

  function buildBodyPreview(value, limit = 1200) {
    if (value === undefined) return '<undefined>';
    try {
      const serialized = JSON.stringify(value);
      if (!serialized) return '<empty>';
      return serialized.length > limit ? `${serialized.slice(0, limit)}...<truncated>` : serialized;
    } catch (_error) {
      return '<unserializable>';
    }
  }

  function getIncomingHeader(req, headerName) {
    return req.headers[headerName] || req.headers[headerName.toLowerCase()] || null;
  }

  function extractIncomingLenderOrgId(req) {
    return req.body?.lender_org_id ||
      req.body?.themisDetail?.lenderOrgId ||
      req.body?.lenderOrgId ||
      getIncomingHeader(req, 'x-lender-org-id');
  }

  function resolveMappingFromHeader(api, req) {
    const headerLogTag = getIncomingHeader(req, 'x-logtag');
    const headerSourceDestination = getIncomingHeader(req, 'x-source_destination');

    if (!headerLogTag || typeof headerLogTag !== 'string' || !headerLogTag.trim()) {
      return null;
    }

    const normalizedHeaderLogTag = headerLogTag.trim().endsWith('_REQUEST')
      ? headerLogTag.trim()
      : `${headerLogTag.trim()}_REQUEST`;

    if (headerSourceDestination && typeof headerSourceDestination === 'string' && headerSourceDestination.trim()) {
      return {
        logTag: normalizedHeaderLogTag,
        api,
        sourceDestination: headerSourceDestination.trim()
      };
    }

    const baseMapping = getApiMapping(api, {
      payload: req.body,
      headers: req.headers
    });
    if (!baseMapping) {
      return null;
    }

    let sourceDestination = baseMapping.sourceDestination;
    if (api === '/lsp/generateKFS' && extractIncomingLenderOrgId(req)) {
      sourceDestination = 'GATEWAY_LENDER';
    }

    return {
      ...baseMapping,
      logTag: normalizedHeaderLogTag,
      sourceDestination
    };
  }

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
    const payload = req.body;
    const loanApplicationId = payload?.loan_application_id || payload?.loanApplicationId || req.headers['x-loan-application-id'];
    const orderId = payload?.order_id || payload?.orderId || req.headers['x-order-id'];
    const lenderOrgId = payload?.lender_org_id ||
                         payload?.themisDetail?.lenderOrgId ||
                         payload?.lenderOrgId ||
                         req.headers['x-lender-org-id'] ||
                         req.headers['X-Lender-Org-Id'];
    const previewOrchestrator = registry.findOrchestrator(req.body, req.headers);
    const nextExpectedEntry =
      previewOrchestrator?.validator?.entries?.[previewOrchestrator?.validator?.currentIndex] || null;
    const lookaheadLogTags = previewOrchestrator?.validator?.entries
      ?.slice(previewOrchestrator?.validator?.currentIndex || 0, (previewOrchestrator?.validator?.currentIndex || 0) + 8)
      ?.map(entry => entry?.logTag)
      ?.filter(Boolean) || [];
    const lookaheadEntries = previewOrchestrator?.validator?.entries
      ?.slice(previewOrchestrator?.validator?.currentIndex || 0, (previewOrchestrator?.validator?.currentIndex || 0) + 8)
      ?.map(entry => ({ logTag: entry?.logTag, index: entry?.index }))
      ?.filter(entry => entry?.logTag) || [];
    const headerDerivedMapping = resolveMappingFromHeader(api, req);
    const configDerivedMapping = getApiMapping(api, {
      payload: req.body,
      headers: req.headers,
      nextExpectedLogTag: nextExpectedEntry?.logTag || null,
      lookaheadLogTags,
      lookaheadEntries,
      currentReplayIndex: previewOrchestrator?.validator?.currentIndex || 0,
      replayScopeKey:
        previewOrchestrator?.config?.registrySessionId ||
        previewOrchestrator?.orderId ||
        orderId ||
        'multiplexer-preview'
    });
    const mapping = headerDerivedMapping || configDerivedMapping;

    if (!mapping) {
      logger.info(`Ignoring unmapped API endpoint (webhook): ${api}`);
      return res.json('Webhook ignored');
    }
    const orchestrator = previewOrchestrator;
    const matchedSession = registry.findSessionForRequest?.(payload, req.headers) || null;
    const requestId = req.headers['x-request-id'] || req.body.request_id || req.body.requestId;

    logger.info('ART_MUX_ROUTE_DECISION', {
      api,
      requestId,
      loanApplicationId,
      orderId,
      lenderOrgId,
      matched: !!orchestrator,
      matchedSessionId: matchedSession?.sessionId || null,
      matchedOrderIds: matchedSession ? Array.from(matchedSession.orderIds || []) : [],
      matchedLoanApplicationCount: matchedSession?.loanApplicationIds?.size || 0,
      matchedOrchestratorRunning: !!orchestrator?.isRunning,
      matchedCurrentEntry: orchestrator?.validator?.getCurrentEntry?.()?.toString?.() || null,
      activeSessions: registry.getAllSessions()
    });

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

    logger.info('ART_MULTIPLEXER_INCOMING_MAPPING_DEBUG', {
      api,
      method: req.method,
      requestId,
      rawHeaders: req.headers,
      rawBodyPreview: buildBodyPreview(req.body),
      headerDerived: {
        logTag: getIncomingHeader(req, 'x-logtag'),
        sourceDestination: getIncomingHeader(req, 'x-source_destination'),
        mapping: headerDerivedMapping
      },
      configDerived: configDerivedMapping,
      finalized: {
        logTag,
        sourceDestination: mapping.sourceDestination,
        source,
        destination
      },
      nextExpectedEntry: nextExpectedEntry
        ? {
            index: nextExpectedEntry.index,
            logTag: nextExpectedEntry.logTag,
            sourceDestination: nextExpectedEntry.sourceDestination
          }
        : null,
      lookaheadEntries,
      activeSessionOrderId: orchestrator?.orderId || null
    });

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
