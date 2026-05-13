import { readFileSync, writeFileSync } from 'fs';
import { resolve } from 'path';
import { logger } from '../utils/logger.js';
import { getOrdersToProcess, runArtProcess } from './art-runner.js';

export function setupRoutes(app, server) {
  app.get('/', (req, res) => {
    res.sendFile(resolve(server.publicDir, 'dashboard.html'));
  });

  app.get('/api/status', (req, res) => {
    res.json({ isRunning: server.isRunning, timestamp: new Date().toISOString() });
  });

  app.post('/api/start-art', async (req, res) => {
    if (server.isRunning) {
      return res.status(400).json({ success: false, message: 'ART is already running' });
    }

    const { merchantId, orderList, lastMinutes } = req.body;

    if (!merchantId) {
      return res.status(400).json({ success: false, message: 'merchantId is required' });
    }

    if ((!orderList || orderList.length === 0) && !lastMinutes) {
      return res.status(400).json({ success: false, message: 'Either orderList or lastMinutes is required' });
    }

    try {
      server.sseManager.broadcast('INFO', 'Starting ART process...');
      server.isRunning = true;

      const ordersToProcess = await getOrdersToProcess(merchantId, orderList, lastMinutes, server.sseManager);

      if (ordersToProcess.length === 0) {
        server.isRunning = false;
        return res.status(400).json({ success: false, message: 'No orders found to process' });
      }

      server.sseManager.broadcast('INFO', `Found ${ordersToProcess.length} orders to process`);

      res.json({
        success: true,
        message: `ART started with ${ordersToProcess.length} orders`,
        orders: ordersToProcess.map(o => o.orderId)
      });

      runArtProcess(merchantId, ordersToProcess, server);

    } catch (error) {
      server.isRunning = false;
      server.sseManager.broadcast('ERROR', `Failed to start ART: ${error.message}`);
      logger.error('Failed to start ART', { error: error.message, stack: error.stack });

      if (!res.headersSent) {
        res.status(500).json({ success: false, message: error.message });
      }
    }
  });

  app.post('/api/stop-art', (req, res) => {
    if (!server.isRunning) {
      return res.json({ success: true, message: 'ART is not running' });
    }

    server.sseManager.broadcast('INFO', 'Stop requested by user — finishing current step and generating report...');

    if (server.artStopSignal) {
      server.artStopSignal.requested = true;
    }

    res.json({ success: true, message: 'Stop signal sent. ART will stop after current step and save the report.' });
  });

  app.post('/api/reset-report', (req, res) => {
    try {
      const reportPath = resolve(process.cwd(), 'report.json');
      writeFileSync(reportPath, JSON.stringify({ orders: [], summary: {} }, null, 2), 'utf-8');
    } catch (_) {}
    res.json({ success: true });
  });

  app.get('/api/report', (req, res) => {
    try {
      const reportPath = resolve(process.cwd(), 'report.json');
      const report = JSON.parse(readFileSync(reportPath, 'utf-8'));
      res.json(report);
    } catch (_) {
      res.status(404).json({ success: false, message: 'No report available yet' });
    }
  });

  app.get('/api/stream-logs', (req, res) => {
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');

    const clientId = Date.now();
    server.sseManager.addClient(clientId, res);
    logger.info(`SSE client connected: ${clientId}`);

    res.write(`data: ${JSON.stringify({
      level: 'INFO',
      message: 'Connected to log stream',
      timestamp: new Date().toISOString()
    })}\n\n`);

    req.on('close', () => {
      server.sseManager.removeClient(clientId);
      logger.info(`SSE client disconnected: ${clientId}`);
    });
  });
}
