import 'dotenv/config';

import { createInterface } from 'readline';
import { fetchLogsFromJSONFile, filterAndSortLogs, filterOrchestratorSkippableLogs } from './services/log-fetcher.js';
import { ReplayOrchestrator } from './orchestrator.js';
import { AsyncReplayOrchestrator } from './async-buffer/async-orchestrator.js';
import { createServer } from './server.js';
import { logger } from './utils/logger.js';
import { createMockController } from './mocks/index.js';
import { MOCK_CONFIG, SERVICE_MAP } from './config.js';
import { runSequentialArt } from './sequential-runner.js';
import { fetchOrderIdsFromQAPI } from './services/http-client.js';

// Configuration
const CONFIG = {
  PORT: process.env.PORT || 3001,
  LOGS_FILE_PATH: process.env.LOGS_FILE_PATH || 'data/logs.json',
  TIMEOUT_MS: parseInt(process.env.TIMEOUT_MS, 10) || 10000,
  AUTO_START: process.env.AUTO_START !== 'false',
  USE_ASYNC_ORCHESTRATOR: process.env.USE_ASYNC_ORCHESTRATOR === 'true',
  AUTO_FETCH_LOGS: process.env.AUTO_FETCH_LOGS === 'true',
  AUTO_FETCH_ORDER_IDS: process.env.AUTO_FETCH_ORDER_IDS === 'true',
  QAPI_ORDER_LIMIT: parseInt(process.env.QAPI_ORDER_LIMIT, 10) || null,
  MERCHANT_ID: process.env.MERCHANT_ID || 'flipkart',
  ORDER_LIST: process.env.ORDER_LIST 
    ? process.env.ORDER_LIST.split(',').map(s => s.trim()).filter(Boolean)
    : [],
  SESSION_TOKEN: process.env.SESSION_TOKEN || '',
  MAX_JOURNEY_TIME_MS: parseInt(process.env.MAX_JOURNEY_TIME_MS, 10) || 180000,
  REPORT_PATH: process.env.REPORT_PATH || 'report.json'
};

/**
 * Main execution flow
 */
async function main() {
  let server = null;
  let orchestrator = null;
  let mocks = null;

  try {
    let orderList = [];

    if (CONFIG.AUTO_FETCH_ORDER_IDS || CONFIG.ORDER_LIST.length === 0) {
      const answers = await askInteractiveConfig();
      
      const minutesBack = answers.minutesBack;
      const endDate = new Date();
      const startDate = new Date(endDate.getTime() - minutesBack * 60 * 1000);
      const startDateStr = startDate.toISOString();
      const endDateStr = endDate.toISOString();

      console.log('\n========================================');
      console.log('Fetching Order IDs from QAPI');
      console.log('========================================');
      console.log(`Merchant: ${answers.merchantId}`);
      console.log(`Lookback: ${minutesBack} minutes`);
      console.log(`Date Range: ${startDateStr} to ${endDateStr}`);
      if (answers.orderLimit) {
        console.log(`Limit: ${answers.orderLimit} orders`);
      }
      console.log('========================================\n');

      const qapiResult = await fetchOrderIdsFromQAPI(
        startDateStr,
        endDateStr,
        [answers.merchantId]
      );

      if (!qapiResult.success) {
        console.error('Failed to fetch order IDs:', qapiResult.error);
        process.exit(1);
      }

      if (qapiResult.count === 0) {
        console.log('No order IDs found from QAPI');
        process.exit(0);
      }

      let orders = qapiResult.orders;
      if (answers.orderLimit && orders.length > answers.orderLimit) {
        orders = orders.slice(0, answers.orderLimit);
        console.log(`Limited to first ${answers.orderLimit} orders`);
      }

      orderList = orders.map(o => ({
        merchantId: o.merchantId,
        orderId: o.orderId
      }));

      console.log(`Fetched ${orderList.length} orders from QAPI`);
      console.log('\nSample orders:');
      orderList.slice(0, 5).forEach((o, i) => {
        console.log(`  ${i + 1}. ${o.orderId} (${o.merchantId})`);
      });
      if (orderList.length > 5) {
        console.log(`  ... and ${orderList.length - 5} more`);
      }
      console.log('');
    } else if (CONFIG.ORDER_LIST.length > 0) {
      orderList = CONFIG.ORDER_LIST.map(orderId => ({
        merchantId: CONFIG.MERCHANT_ID,
        orderId
      }));
    }

    if (CONFIG.AUTO_FETCH_LOGS && orderList.length > 0) {
      console.log('\n========================================');
      console.log('Auto-fetch enabled - Running Sequential ART');
      console.log(`Total Orders: ${orderList.length}`);
      console.log('========================================\n');

      const result = await runSequentialArt(orderList, CONFIG);
      
      console.log('\n========================================');
      console.log('Sequential ART Complete');
      console.log(`Overall Success: ${result.success}`);
      console.log('========================================\n');
      
      process.exit(result.success ? 0 : 1);
    }

    console.log('Loading logs from file...');
    const logs = await fetchLogsFromJSONFile(CONFIG.LOGS_FILE_PATH);

    if (logs.length === 0) {
      console.log('No logs to process');
      process.exit(1);
    }

    console.log(`Loaded ${logs.length} logs`);

    console.log('Filtering and sorting logs...');
    const filteredLogs = await filterAndSortLogs(logs, 'data/filtered-logs.json');
    
    if (filteredLogs.length === 0) {
      console.log('No logs remaining after filtering');
      process.exit(1);
    }

    console.log('Applying second-level filtering (removing orchestrator-skipped entries)...');
    const finalFilteredLogs = await filterOrchestratorSkippableLogs(filteredLogs, 'data/final-filtered-logs.json');
    
    if (finalFilteredLogs.length === 0) {
      console.log('No logs remaining after second-level filtering');
      process.exit(1);
    }

    console.log(`Ready to replay ${finalFilteredLogs.length} unique logs`);

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
    const OrchestratorClass = CONFIG.USE_ASYNC_ORCHESTRATOR ? AsyncReplayOrchestrator : ReplayOrchestrator;
    orchestrator = new OrchestratorClass(finalFilteredLogs, {
      timeoutMs: CONFIG.TIMEOUT_MS
    });

    if (CONFIG.USE_ASYNC_ORCHESTRATOR) {
      console.log('\n⚡ Using ASYNC orchestrator with buffer system');
    }

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
      if (CONFIG.USE_ASYNC_ORCHESTRATOR) {
        console.log(`\n⚡ Async orchestrator mode active`);
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

function askQuestion(query, defaultValue = '') {
  const rl = createInterface({
    input: process.stdin,
    output: process.stdout
  });

  return new Promise(resolve => {
    const prompt = defaultValue ? `${query} [${defaultValue}]: ` : `${query}: `;
    rl.question(prompt, answer => {
      rl.close();
      resolve(answer.trim() || defaultValue);
    });
  });
}

async function askInteractiveConfig() {
  console.log('\n========================================');
  console.log('ART - Automated Regression Testing');
  console.log('========================================\n');

  const defaultMinutes = CONFIG.QAPI_START_DATE ? 10080 : 1440;
  const minutesBackInput = await askQuestion('How many minutes back should we fetch orders for?', String(defaultMinutes));
  const minutesBack = parseInt(minutesBackInput, 10);
  if (isNaN(minutesBack) || minutesBack <= 0) {
    console.error(`Invalid minutes: "${minutesBackInput}". Must be a positive number.`);
    process.exit(1);
  }

  const merchantId = await askQuestion('Merchant ID', CONFIG.MERCHANT_ID || 'flipkart');

  const orderLimitInput = await askQuestion('Max orders to process (empty = no limit)', CONFIG.QAPI_ORDER_LIMIT ? String(CONFIG.QAPI_ORDER_LIMIT) : '');
  const orderLimit = orderLimitInput ? parseInt(orderLimitInput, 10) : null;
  if (orderLimitInput && (isNaN(orderLimit) || orderLimit <= 0)) {
    console.error(`Invalid limit: "${orderLimitInput}". Must be a positive number or empty.`);
    process.exit(1);
  }

  return { minutesBack, merchantId, orderLimit };
}

// Run main
main();

// Export for testing
export { main };
