import 'dotenv/config';

import { fetchLogsFromJSONFile } from './services/log-fetcher.js';
import { ReplayOrchestrator } from './orchestrator.js';
import { createServer } from './server.js';
import { logger } from './utils/logger.js';
import { createMockController } from './mocks/index.js';
import { MOCK_CONFIG, SERVICE_MAP } from './config.js';

// Configuration
const CONFIG = {
  PORT: process.env.PORT || 3001,
  LOGS_FILE_PATH: process.env.LOGS_FILE_PATH || 'data/logs.json',
  TIMEOUT_MS: parseInt(process.env.TIMEOUT_MS, 10) || 30000,
  AUTO_START: process.env.AUTO_START !== 'false'
};

/**
 * Main execution flow
 */
async function main() {
  let server = null;
  let orchestrator = null;
  let mocks = null;

  try {
    // Load logs
    console.log('Loading logs from file...');
    const logs = await fetchLogsFromJSONFile(CONFIG.LOGS_FILE_PATH);

    if (logs.length === 0) {
      console.log('No logs to process');
      process.exit(1);
    }

    console.log(`Loaded ${logs.length} logs`);

    // Start mock services if enabled
    if (MOCK_CONFIG.enabled) {
      console.log('\n🔧 Mock mode enabled - starting mock services...');

      // Derive ports from URLs
      const lspPort = new URL(MOCK_CONFIG.mockLspUrl).port || 4232;
      const gwPort = new URL(MOCK_CONFIG.mockGwUrl).port || 2344;

      mocks = createMockController({
        lspPort: parseInt(lspPort, 10),
        gwPort: parseInt(gwPort, 10),
        orchestratorUrl: `http://localhost:${CONFIG.PORT}`
      });

      await mocks.start(logs);

      // Override service URLs to point to mocks
      SERVICE_MAP.LSP.baseUrl = MOCK_CONFIG.mockLspUrl;
      SERVICE_MAP.GW.baseUrl = MOCK_CONFIG.mockGwUrl;

      console.log(`✅ Mock services started:`);
      console.log(`   - LSP mock: ${MOCK_CONFIG.mockLspUrl}`);
      console.log(`   - GW mock:  ${MOCK_CONFIG.mockGwUrl}`);
    }

    // Create orchestrator
    orchestrator = new ReplayOrchestrator(logs, {
      timeoutMs: CONFIG.TIMEOUT_MS
    });

    // Create and start HTTP server
    const app = createServer(orchestrator);
    server = app.listen(CONFIG.PORT, () => {
      console.log(`\n🚀 ART Orchestrator Server running on port ${CONFIG.PORT}`);
      console.log(`\nEndpoints:`);
      console.log(`  - Health:  http://localhost:${CONFIG.PORT}/health`);
      console.log(`  - Status:  http://localhost:${CONFIG.PORT}/status`);
      console.log(`  - LSP:     http://localhost:${CONFIG.PORT}/lsp/*`);
      console.log(`  - GW:      http://localhost:${CONFIG.PORT}/gw/*`);
      console.log(`  - Control: http://localhost:${CONFIG.PORT}/control/{start|stop}`);
      if (MOCK_CONFIG.enabled) {
        console.log(`\n📡 Mock mode active`);
      }
      console.log(`\nReplay ready. Call /control/start to begin.\n`);
    });

    // Auto-start if configured
    if (CONFIG.AUTO_START) {
      console.log('✅ Replay auto-started');
      await orchestrator.start();
    }

    // Graceful shutdown
    process.on('SIGINT', async () => {
      console.log('\n\nShutting down gracefully...');
      if (orchestrator) {
        await orchestrator.stop();
        const results = orchestrator.getResults();
        console.log('\n=== Final Results ===');
        console.log(JSON.stringify(results, null, 2));
      }
      if (mocks) {
        await mocks.stop();
      }
      if (server) {
        server.close(() => {
          console.log('Server closed');
          process.exit(0);
        });
      }
    });

    process.on('SIGTERM', async () => {
      console.log('\n\nReceived SIGTERM, shutting down...');
      if (orchestrator) {
        await orchestrator.stop();
      }
      if (mocks) {
        await mocks.stop();
      }
      if (server) {
        server.close(() => process.exit(0));
      }
    });

  } catch (error) {
    console.error('Failed to start:', error.message);
    console.error(error.stack);

    if (server) {
      server.close();
    }
    if (orchestrator) {
      await orchestrator.stop();
    }
    if (mocks) {
      await mocks.stop();
    }

    process.exit(1);
  }
}

// Run main
main();

// Export for testing
export { main };
