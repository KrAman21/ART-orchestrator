import { fetchLogsFromJSONFile } from './services/log-fetcher.js';
import { ReplayOrchestrator } from './orchestrator.js';
import { createServer } from './server.js';
import { logger } from './utils/logger.js';

// Configuration
const CONFIG = {
  PORT: process.env.PORT || 3001,
  LOGS_FILE_PATH: process.env.LOGS_FILE_PATH || 'data/logs.json',
  TIMEOUT_MS: parseInt(process.env.TIMEOUT_MS, 10) || 30000,
  AUTO_START: process.env.AUTO_START !== 'false' // Default to auto-start
};

/**
 * Main execution flow
 */
async function main() {
  let server = null;
  let orchestrator = null;

  try {
    // Load logs
    console.log('Loading logs from file...');
    const logs = await fetchLogsFromJSONFile(CONFIG.LOGS_FILE_PATH);

    if (logs.length === 0) {
      console.log('No logs to process');
      process.exit(1);
    }

    console.log(`Loaded ${logs.length} logs`);

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
      console.log(`\nReplay ready. Call /control/start to begin.\n`);
    });

    // Auto-start if configured
    if (CONFIG.AUTO_START) {
      await orchestrator.start();
      console.log('✅ Replay auto-started');
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

    process.exit(1);
  }
}

// Run main
main();

// Export for testing
export { main };
