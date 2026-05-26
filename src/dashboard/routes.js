import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'fs';
import { resolve, dirname } from 'path';
import { logger } from '../utils/logger.js';
import { getOrdersToProcess, runArtProcess } from './art-runner.js';

function getSessionId(req) {
  return req.headers['x-session-id'] || req.query.sessionId || req.body?.sessionId || null;
}

function requireSession(req, res) {
  const sessionId = getSessionId(req);
  if (!sessionId) {
    res.status(400).json({ success: false, message: 'sessionId is required (pass via x-session-id header, query param, or body)' });
    return null;
  }
  return sessionId;
}

export function setupRoutes(app, server) {
  app.get('/', (req, res) => {
    res.sendFile(resolve(server.publicDir, 'dashboard.html'));
  });

  app.get('/api/status', (req, res) => {
    const sessionId = getSessionId(req);
    if (sessionId) {
      const session = server.getSession(sessionId);
      res.json({
        isRunning: session ? session.isRunning : false,
        sessionId,
        timestamp: new Date().toISOString()
      });
    } else {
      const activeSessions = server.getActiveSessions();
      res.json({
        activeSessions: activeSessions.length,
        sessions: activeSessions.map(s => ({
          sessionId: s.sessionId,
          isRunning: s.isRunning,
          createdAt: s.createdAt
        })),
        timestamp: new Date().toISOString()
      });
    }
  });

  app.post('/api/start-art', async (req, res) => {
    const sessionId = requireSession(req, res);
    if (!sessionId) return;

    const session = server.getOrCreateSession(sessionId);

    if (session.isRunning) {
      return res.status(400).json({ success: false, message: 'ART is already running in this session' });
    }

    const { merchantId, orderList, lastMinutes, flowType, subType } = req.body;

    if (!merchantId) {
      return res.status(400).json({ success: false, message: 'merchantId is required' });
    }

    if ((!orderList || orderList.length === 0) && !lastMinutes) {
      return res.status(400).json({ success: false, message: 'Either orderList or lastMinutes is required' });
    }

    try {
      session.sseManager.broadcast('INFO', 'Starting ART process...');
      session.isRunning = true;

      const ordersToProcess = await getOrdersToProcess(
        merchantId,
        orderList,
        lastMinutes,
        {
          flowType,
          subType
        },
        session.sseManager
      );

      if (ordersToProcess.length === 0) {
        session.isRunning = false;
        return res.status(400).json({ success: false, message: 'No orders found to process' });
      }

      session.sseManager.broadcast('INFO', `Found ${ordersToProcess.length} orders to process`);

      const reportDir = resolve(process.cwd(), 'reports', sessionId);
      if (!existsSync(reportDir)) {
        mkdirSync(reportDir, { recursive: true });
      }
      const reportPath = resolve(reportDir, 'report.json');
      session.reportPath = reportPath;

      res.json({
        success: true,
        message: `ART started with ${ordersToProcess.length} orders`,
        orders: ordersToProcess.map(o => o.orderId),
        sessionId
      });

      runArtProcess(merchantId, ordersToProcess, server, session);

    } catch (error) {
      session.isRunning = false;
      session.sseManager.broadcast('ERROR', `Failed to start ART: ${error.message}`);
      logger.error('Failed to start ART', { error: error.message, stack: error.stack, sessionId });

      if (!res.headersSent) {
        res.status(500).json({ success: false, message: error.message });
      }
    }
  });

  app.post('/api/stop-art', (req, res) => {
    const sessionId = requireSession(req, res);
    if (!sessionId) return;

    const session = server.getSession(sessionId);
    if (!session || !session.isRunning) {
      return res.json({ success: true, message: 'ART is not running in this session' });
    }

    session.sseManager.broadcast('INFO', 'Stop requested by user — finishing current step and generating report...');

    if (session.artStopSignal) {
      session.artStopSignal.requested = true;
    }

    res.json({ success: true, message: 'Stop signal sent. ART will stop after current step and save the report.' });
  });

  app.post('/api/reset-report', (req, res) => {
    const sessionId = getSessionId(req);
    try {
      const reportPath = sessionId && server.getSession(sessionId)?.reportPath
        ? server.getSession(sessionId).reportPath
        : resolve(process.cwd(), 'report.json');
      writeFileSync(reportPath, JSON.stringify({ orders: [], summary: {} }, null, 2), 'utf-8');
    } catch (_) {}
    res.json({ success: true });
  });

  app.get('/api/report', (req, res) => {
    const sessionId = getSessionId(req);
    try {
      const reportPath = sessionId && server.getSession(sessionId)?.reportPath
        ? server.getSession(sessionId).reportPath
        : resolve(process.cwd(), 'report.json');
      const report = JSON.parse(readFileSync(reportPath, 'utf-8'));
      res.json(report);
    } catch (_) {
      res.status(404).json({ success: false, message: 'No report available yet' });
    }
  });

  app.get('/api/stream-logs', (req, res) => {
    const sessionId = req.query.sessionId;
    if (!sessionId) {
      res.status(400).json({ success: false, message: 'sessionId query parameter is required' });
      return;
    }

    const session = server.getOrCreateSession(sessionId);

    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');

    const clientId = Date.now();
    session.sseManager.addClient(clientId, res);
    logger.info(`SSE client connected: ${clientId} (session: ${sessionId})`);

    res.write(`data: ${JSON.stringify({
      level: 'INFO',
      message: 'Connected to log stream',
      timestamp: new Date().toISOString()
    })}\n\n`);

    req.on('close', () => {
      session.sseManager.removeClient(clientId);
      logger.info(`SSE client disconnected: ${clientId} (session: ${sessionId})`);
    });
  });
}
