import express from 'express';
import { createServer } from 'http';
import { readFileSync, writeFileSync } from 'fs';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';
import { logger } from './utils/logger.js';
import { BatchLogFetcher } from './log-fetcher/index.js';
import { ArtReportGenerator } from './services/art-report-generator.js';
import { runSequentialArt } from './sequential-runner.js';
import { MOCKS_ENABLED, SERVICE_PORTS, QAPI_CONFIG } from './config.js';

const __dirname = dirname(fileURLToPath(import.meta.url));

class DashboardServer {
  constructor(options = {}) {
    this.port = options.port || 3001;
    this.app = express();
    this.server = createServer(this.app);
    this.isRunning = false;
    this.currentRunner = null;
    this.artStopSignal = null;
    this.logClients = new Set();
    this.setupMiddleware();
    this.setupRoutes();
  }

  setupMiddleware() {
    this.app.use(express.json());
    // Force connection close on every response — prevents VS Code SSH tunnel from
    // keeping the connection open and making Chrome think the page is still loading
    this.app.use((req, res, next) => {
      if (!req.path.startsWith('/api/stream-logs')) {
        res.set('Connection', 'close');
      }
      next();
    });
    this.app.use(express.static(resolve(__dirname, '../public')));
    this.app.use((req, res, next) => {
      logger.debug('Dashboard request', { method: req.method, path: req.path });
      next();
    });
  }

  setupRoutes() {
    this.app.get('/', (req, res) => {
      res.sendFile(resolve(__dirname, '../public/dashboard.html'));
    });

    this.app.get('/api/status', (req, res) => {
      res.json({
        isRunning: this.isRunning,
        timestamp: new Date().toISOString()
      });
    });

    this.app.post('/api/start-art', async (req, res) => {
      if (this.isRunning) {
        return res.status(400).json({
          success: false,
          message: 'ART is already running'
        });
      }

      const { merchantId, orderList, lastMinutes } = req.body;

      if (!merchantId) {
        return res.status(400).json({
          success: false,
          message: 'merchantId is required'
        });
      }

      if ((!orderList || orderList.length === 0) && !lastMinutes) {
        return res.status(400).json({
          success: false,
          message: 'Either orderList or lastMinutes is required'
        });
      }

      try {
        this.broadcastLog('INFO', 'Starting ART process...');
        this.isRunning = true;

        const ordersToProcess = await this.getOrdersToProcess(merchantId, orderList, lastMinutes);
        
        if (ordersToProcess.length === 0) {
          this.isRunning = false;
          return res.status(400).json({
            success: false,
            message: 'No orders found to process'
          });
        }

        this.broadcastLog('INFO', `Found ${ordersToProcess.length} orders to process`);

        res.json({
          success: true,
          message: `ART started with ${ordersToProcess.length} orders`,
          orders: ordersToProcess.map(o => o.orderId)
        });

        this.runArtProcess(merchantId, ordersToProcess);

      } catch (error) {
        this.isRunning = false;
        this.broadcastLog('ERROR', `Failed to start ART: ${error.message}`);
        logger.error('Failed to start ART', { error: error.message, stack: error.stack });
        
        if (!res.headersSent) {
          res.status(500).json({
            success: false,
            message: error.message
          });
        }
      }
    });

    this.app.post('/api/stop-art', (req, res) => {
      if (!this.isRunning) {
        return res.json({
          success: true,
          message: 'ART is not running'
        });
      }

      this.broadcastLog('INFO', 'Stop requested by user — finishing current step and generating report...');

      if (this.artStopSignal) {
        this.artStopSignal.requested = true;
      }

      res.json({
        success: true,
        message: 'Stop signal sent. ART will stop after current step and save the report.'
      });
    });

    this.app.post('/api/reset-report', (req, res) => {
      try {
        const reportPath = resolve(process.cwd(), 'report.json');
        writeFileSync(reportPath, JSON.stringify({ orders: [], summary: {} }, null, 2), 'utf-8');
      } catch (_) {}
      res.json({ success: true });
    });

    this.app.get('/api/report', async (req, res) => {
      try {
        const reportPath = resolve(process.cwd(), 'report.json');
        const report = JSON.parse(readFileSync(reportPath, 'utf-8'));
        res.json(report);
      } catch (error) {
        res.status(404).json({
          success: false,
          message: 'No report available yet'
        });
      }
    });

    this.app.get('/api/stream-logs', (req, res) => {
      res.setHeader('Content-Type', 'text/event-stream');
      res.setHeader('Cache-Control', 'no-cache');
      res.setHeader('Connection', 'keep-alive');

      const clientId = Date.now();
      this.logClients.add({ id: clientId, res });

      logger.info(`SSE client connected: ${clientId}`);

      res.write(`data: ${JSON.stringify({
        level: 'INFO',
        message: 'Connected to log stream',
        timestamp: new Date().toISOString()
      })}\n\n`);

      req.on('close', () => {
        this.logClients.delete(clientId);
        logger.info(`SSE client disconnected: ${clientId}`);
      });
    });
  }

  async getOrdersToProcess(merchantId, orderList, lastMinutes) {
    const orders = [];

    if (orderList && orderList.length > 0) {
      for (const orderId of orderList) {
        orders.push({ merchantId, orderId });
      }
    } else if (lastMinutes) {
      const endDate = new Date();
      const startDate = new Date(endDate.getTime() - lastMinutes * 60 * 1000);
      
      this.broadcastLog('INFO', `Fetching orders from last ${lastMinutes} minutes...`);
      
      const fetcher = new BatchLogFetcher({
        outputPath: 'data/logs.json',
        delayBetweenRequests: 500,
        maxRetries: 3
      });

      const orderIds = await this.fetchRecentOrderIds(merchantId, startDate, endDate);
      
      for (const orderId of orderIds) {
        orders.push({ merchantId, orderId });
      }
    }

    return orders;
  }

  async fetchRecentOrderIds(merchantId, startDate, endDate) {
    if (!QAPI_CONFIG.token) {
      logger.warn('QAPI_TOKEN not configured, skipping order fetch from QAPI');
      return [];
    }

    const { fetchOrderIdsFromQAPI } = await import('./services/http-client.js');
    
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

  broadcastLogRaw(level, message) {
    const logData = {
      level,
      message,
      timestamp: new Date().toISOString()
    };

    for (const client of this.logClients) {
      try {
        client.res.write(`data: ${JSON.stringify(logData)}\n\n`);
      } catch (error) {
        this.logClients.delete(client.id);
      }
    }
  }

  broadcastLog(level, message) {
    this.broadcastLogRaw(level, message);
    logger[level.toLowerCase()]?.(message) || logger.info(message);
  }

  broadcastReportReady() {
    const logData = {
      level: 'INFO',
      message: 'Report ready',
      timestamp: new Date().toISOString(),
      reportUpdate: true
    };
    for (const client of this.logClients) {
      try {
        client.res.write(`data: ${JSON.stringify(logData)}\n\n`);
      } catch (error) {
        this.logClients.delete(client);
      }
    }
  }

  async runArtProcess(merchantId, orders) {
    const stopSignal = { requested: false };
    this.artStopSignal = stopSignal;

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

      const boundInfo = logger.info.bind(logger);
      const boundWarn = logger.warn.bind(logger);
      const boundError = logger.error.bind(logger);

      logger.info = (...args) => {
        const message = typeof args[0] === 'string' ? args[0] : JSON.stringify(args[0]);
        this.broadcastLogRaw('INFO', message);
        return boundInfo(...args);
      };

      logger.warn = (...args) => {
        const message = typeof args[0] === 'string' ? args[0] : JSON.stringify(args[0]);
        this.broadcastLogRaw('WARN', message);
        return boundWarn(...args);
      };

      logger.error = (...args) => {
        const message = typeof args[0] === 'string' ? args[0] : JSON.stringify(args[0]);
        this.broadcastLogRaw('ERROR', message);
        return boundError(...args);
      };

      const result = await runSequentialArt(orders, config);

      const wasStopped = stopSignal.requested;
      this.broadcastLog('INFO', wasStopped
        ? 'ART stopped by user. Report has been saved.'
        : `ART completed. Successful: ${result.success}`
      );

      if (result.results) {
        const successCount = result.results.filter(r => r.success).length;
        const failCount = result.results.filter(r => !r.success).length;
        this.broadcastLog('INFO', `Results: ${successCount} succeeded, ${failCount} failed`);
      }

      this.broadcastReportReady();

    } catch (error) {
      this.broadcastLog('ERROR', `ART failed: ${error.message}`);
      logger.error('ART process failed', { error: error.message, stack: error.stack });
      this.broadcastReportReady();
    } finally {
      this.isRunning = false;
      this.currentRunner = null;
      this.artStopSignal = null;
    }
  }

  async start() {
    return new Promise((resolve) => {
      this.server.listen(this.port, () => {
        logger.info(`Dashboard server running on http://localhost:${this.port}`);
        console.log(`\n🎭 ART Dashboard available at: http://localhost:${this.port}`);
        console.log('Press Ctrl+C to stop\n');
        resolve();
      });
    });
  }

  async stop() {
    return new Promise((resolve) => {
      for (const client of this.logClients) {
        try {
          client.res.end();
        } catch (e) {}
      }
      this.logClients.clear();

      this.server.close(() => {
        logger.info('Dashboard server stopped');
        resolve();
      });
    });
  }
}

export default DashboardServer;
