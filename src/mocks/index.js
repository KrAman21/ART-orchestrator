import { LSPMockService } from './lsp-mock.js';
import { GWMockService } from './gw-mock.js';
import { logger } from '../utils/logger.js';

/**
 * MockServiceController - Manages LSP and GW mock services
 *
 * Usage:
 *   const mocks = createMockController({
 *     lspPort: 4232,
 *     gwPort: 2344,
 *     orchestratorUrl: 'http://art-orchestrator'
 *   });
 *   await mocks.start(logs);
 *   ... run replay ...
 *   await mocks.stop();
 */
export class MockServiceController {
  constructor(config = {}) {
    this.config = {
      lspPort: config.lspPort || 4232,
      gwPort: config.gwPort || 2344,
      orchestratorUrl: config.orchestratorUrl || 'http://art-orchestrator',
      ...config
    };

    this.lspMock = new LSPMockService({
      port: this.config.lspPort,
      orchestratorUrl: this.config.orchestratorUrl
    });

    this.gwMock = new GWMockService({
      port: this.config.gwPort,
      orchestratorUrl: this.config.orchestratorUrl
    });

    this.isRunning = false;
  }

  /**
   * Start both mock services
   * @param {Array} logs - Production logs for mocks to simulate
   */
  async start(logs) {
    if (this.isRunning) {
      logger.warn('Mocks already running');
      return;
    }

    logger.info('Starting mock services...');

    // Load logs into both mocks
    // Each mock will filter relevant entries
    this.lspMock.loadLogs(logs);
    this.gwMock.loadLogs(logs);

    // Start both servers
    await Promise.all([
      this.lspMock.start(),
      this.gwMock.start()
    ]);

    this.isRunning = true;
    logger.info('Mock services started successfully');
  }

  /**
   * Stop both mock services
   */
  async stop() {
    if (!this.isRunning) {
      return;
    }

    logger.info('Stopping mock services...');

    await Promise.all([
      this.lspMock.stop(),
      this.gwMock.stop()
    ]);

    this.isRunning = false;
    logger.info('Mock services stopped');
  }

  /**
   * Get status of both mocks
   */
  getStatus() {
    return {
      isRunning: this.isRunning,
      lsp: this.lspMock.getStatus(),
      gw: this.gwMock.getStatus()
    };
  }

  /**
   * Reset both mocks (clear processed indices)
   */
  async reset() {
    logger.info('Resetting mock services...');
    this.lspMock.processedIndices.clear();
    this.gwMock.processedIndices.clear();
  }
}

/**
 * Factory function to create mock controller
 */
export function createMockController(config) {
  return new MockServiceController(config);
}

export default MockServiceController;
