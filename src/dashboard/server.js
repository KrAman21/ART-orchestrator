import express from 'express';
import { createServer as createHttpServer } from 'http';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';
import { logger } from '../utils/logger.js';
import { SseManager } from './sse.js';
import { setupRoutes } from './routes.js';
import { startMultiplexerServer } from './multiplexer.js';

const __dirname = dirname(fileURLToPath(import.meta.url));

class DashboardServer {
  constructor(options = {}) {
    this.dashboardPort = options.port || 3002;
    this.orchestratorPort = options.orchestratorPort || 3001;
    this.publicDir = resolve(__dirname, '../../public');
    this.app = express();
    this.server = createHttpServer(this.app);
    this.sessions = new Map();
    this.orchestratorServer = null;
    this.registry = null;
    this.setupMiddleware();
    setupRoutes(this.app, this);
  }

  getOrCreateSession(sessionId) {
    if (!this.sessions.has(sessionId)) {
      this.sessions.set(sessionId, {
        sessionId,
        isRunning: false,
        artStopSignal: null,
        sseManager: new SseManager(),
        reportPath: null,
        createdAt: new Date().toISOString()
      });
    }
    return this.sessions.get(sessionId);
  }

  getSession(sessionId) {
    return this.sessions.get(sessionId) || null;
  }

  cleanupSession(sessionId) {
    const session = this.sessions.get(sessionId);
    if (session) {
      session.sseManager.closeAll();
      if (this.registry) {
        this.registry.unregister(sessionId);
      }
      this.sessions.delete(sessionId);
    }
  }

  getActiveSessions() {
    return Array.from(this.sessions.values());
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
    const { server: orchServer, registry } = await startMultiplexerServer(this.orchestratorPort);
    this.orchestratorServer = orchServer;
    this.registry = registry;

    return new Promise((resolve) => {
      this.server.listen(this.dashboardPort, () => {
        logger.info(`Dashboard server running on http://localhost:${this.dashboardPort}`);
        console.log(`\n🎭 ART Dashboard available at: http://localhost:${this.dashboardPort}`);
        console.log(`🔀 Orchestrator server on port: ${this.orchestratorPort}`);
        console.log('Press Ctrl+C to stop\n');
        resolve();
      });
    });
  }

  async stop() {
    for (const session of this.sessions.values()) {
      session.sseManager.closeAll();
    }
    if (this.registry) {
      for (const sessionData of this.sessions.values()) {
        this.registry.unregister(sessionData.sessionId);
      }
    }
    return new Promise((resolve) => {
      this.server.close(() => {
        if (this.orchestratorServer) {
          this.orchestratorServer.close(() => {
            logger.info('All servers stopped');
            resolve();
          });
        } else {
          logger.info('Dashboard server stopped');
          resolve();
        }
      });
    });
  }
}

export default DashboardServer;
