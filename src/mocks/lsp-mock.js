import express from 'express';
import { BaseMockService } from './mock-base.js';
import { logger } from '../utils/logger.js';

/**
 * LSPMockService - Mock implementation of LSP service
 *
 * Receives requests from Orchestrator (meant for LSP)
 * Simulates LSP behavior based on production logs
 */
export class LSPMockService extends BaseMockService {
  constructor(config) {
    super('LSP', {
      port: config.port || 4232,
      orchestratorUrl: config.orchestratorUrl,
      ...config
    });
    this.app = null;
  }

  /**
   * Start the mock HTTP server
   */
  async start() {
    return new Promise((resolve, reject) => {
      this.app = express();
      this.app.use(express.json({ limit: '10mb' }));

      // Request logging middleware
      this.app.use((req, _res, next) => {
        logger.debug('LSP mock received request', {
          method: req.method,
          path: req.path,
          'x-request-id': req.headers['x-request-id']
        });
        next();
      });

      // Health check
      this.app.get('/health', (_req, res) => {
        res.json({ status: 'healthy', service: 'LSP_MOCK' });
      });

      // Status endpoint
      this.app.get('/status', (_req, res) => {
        res.json(this.getStatus());
      });

      // Reset endpoint - clear processed indices
      this.app.post('/reset', (_req, res) => {
        this.processedIndices.clear();
        res.json({ success: true, message: 'LSP mock reset' });
      });

      // Seed data onboarding endpoint
      this.app.post('/art/configs/set', (req, res) => {
        const { merchantId, lenderOrgIdToIdMap } = req.body;
        logger.info('LSP mock: Seed data onboarding', { merchantId, lenderCount: lenderOrgIdToIdMap ? Object.keys(lenderOrgIdToIdMap).length : 0 });
        res.json({
          success: true,
          message: 'Seed data onboarded successfully',
          merchantId
        });
      });

      // Generic request handler - catches all API endpoints
      this.app.use('*', async (req, res) => {
        try {
          const api = req.originalUrl;
          const payload = req.body;
          const requestId = req.headers['x-request-id'];
          const loanApplicationId = payload?.loan_application_id || payload?.applicationid;

          const result = await this.handleRequest(api, payload, requestId, loanApplicationId);

          res.status(result.status).json(result.data);

        } catch (error) {
          logger.error('LSP mock error', { error: error.message });
          res.status(500).json({
            success: false,
            error: error.message
          });
        }
      });

      // Error handler
      this.app.use((err, _req, res, _next) => {
        logger.error('LSP mock unhandled error', { error: err.message });
        res.status(500).json({
          success: false,
          error: 'Internal mock error'
        });
      });

      this.server = this.app.listen(this.port, () => {
        logger.info(`LSP mock server started on port ${this.port}`);
        resolve();
      });

      this.server.on('error', reject);
    });
  }

  /**
   * Stop the mock server
   */
  async stop() {
    return new Promise((resolve) => {
      if (this.server) {
        this.server.close(() => {
          logger.info('LSP mock server stopped');
          resolve();
        });
      } else {
        resolve();
      }
    });
  }
}

export default LSPMockService;
