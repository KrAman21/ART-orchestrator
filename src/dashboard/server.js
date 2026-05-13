import express from 'express';
import { createServer } from 'http';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';
import { logger } from '../utils/logger.js';
import { SseManager } from './sse.js';
import { setupRoutes } from './routes.js';

const __dirname = dirname(fileURLToPath(import.meta.url));

class DashboardServer {
  constructor(options = {}) {
    this.port = options.port || 3001;
    this.publicDir = resolve(__dirname, '../../public');
    this.app = express();
    this.server = createServer(this.app);
    this.isRunning = false;
    this.artStopSignal = null;
    this.sseManager = new SseManager();
    this.setupMiddleware();
    setupRoutes(this.app, this);
  }

  setupMiddleware() {
    this.app.use(express.json());
    this.app.use((req, res, next) => {
      if (!req.path.startsWith('/api/stream-logs')) {
        res.set('Connection', 'close');
      }
      next();
    });
    this.app.use(express.static(this.publicDir));
    this.app.use((req, res, next) => {
      logger.debug('Dashboard request', { method: req.method, path: req.path });
      next();
    });
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
      this.sseManager.closeAll();
      this.server.close(() => {
        logger.info('Dashboard server stopped');
        resolve();
      });
    });
  }
}

export default DashboardServer;
