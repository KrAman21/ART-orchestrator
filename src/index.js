import 'dotenv/config';

import { createInterface } from 'readline';
import { mkdirSync, chmodSync, unlinkSync, existsSync } from 'fs';
import { createServer as createHttpServer } from 'http';
import { dirname } from 'path';
import { fetchLogsFromJSONFile, filterAndSortLogs, filterOrchestratorSkippableLogs } from './services/log-fetcher.js';
import { ReplayOrchestrator } from './orchestrator.js';
import { AsyncReplayOrchestrator } from './async-buffer/async-orchestrator.js';
import { createServer } from './server.js';
import { logger } from './utils/logger.js';
import { createMockController } from './mocks/index.js';
import { MOCK_CONFIG, SERVICE_MAP } from './config.js';
import { runSequentialArt } from './sequential-runner.js';
import { fetchOrderIdsFromQAPI } from './services/http-client.js';
import { startMultiplexerServer } from './dashboard/multiplexer.js';

// Configuration
const CONFIG = {
  ART_PORT: parseInt(process.env.ART_PORT, 10) || 3002,
  ART_UNIX_SOCKET_PATH: process.env.ART_UNIX_SOCKET_PATH || null,
  LOGS_FILE_PATH: process.env.LOGS_FILE_PATH || 'data/logs.json',
  TIMEOUT_MS: parseInt(process.env.TIMEOUT_MS, 10) || 10000,
  AUTO_START: process.env.AUTO_START !== 'false',
  USE_ASYNC_ORCHESTRATOR: process.env.USE_ASYNC_ORCHESTRATOR === 'true',
  AUTO_FETCH_LOGS: process.env.AUTO_FETCH_LOGS === 'true',
  AUTO_FETCH_ORDER_IDS: process.env.AUTO_FETCH_ORDER_IDS === 'true',
  LAST_MINUTES: process.env.LAST_MINUTES ? parseInt(process.env.LAST_MINUTES, 10) : null,
  QAPI_ORDER_LIMIT: parseInt(process.env.QAPI_ORDER_LIMIT, 10) || null,
  MERCHANT_ID: process.env.MERCHANT_ID || 'flipkart',
  FLOW_TYPE: process.env.FLOW_TYPE || '',
  SUB_TYPE: process.env.SUB_TYPE || '',
  ORDER_LIST: process.env.ORDER_LIST
    ? process.env.ORDER_LIST.split(',').map(s => s.trim()).filter(Boolean)
    : [],
  SESSION_TOKEN: process.env.SESSION_TOKEN || '',
  MAX_JOURNEY_TIME_MS: parseInt(process.env.MAX_JOURNEY_TIME_MS, 10) || 180000,
  REPORT_PATH: process.env.REPORT_PATH || 'report.json',
  KEEP_ORDER_TEMP_FILES: process.env.KEEP_ORDER_TEMP_FILES === 'true',
  ENABLE_BATCH_PROCESSING: process.env.ENABLE_BATCH_PROCESSING !== 'false'
};

function getConfiguredFetchInputs() {
  if (process.env.LAST_MINUTES === undefined || process.env.LAST_MINUTES === '') {
    return null;
  }

  if (!Number.isInteger(CONFIG.LAST_MINUTES) || CONFIG.LAST_MINUTES <= 0) {
    throw new Error('LAST_MINUTES must be set to a positive integer when using env-based QAPI order fetching');
  }

  return {
    minutesBack: CONFIG.LAST_MINUTES,
    merchantId: CONFIG.MERCHANT_ID,
    orderLimit: CONFIG.QAPI_ORDER_LIMIT,
    flowType: CONFIG.FLOW_TYPE,
    subType: CONFIG.SUB_TYPE
  };
}

/**
 * Main execution flow
 */
async function main() {
  let server = null;
  let orchestrator = null;
  let mocks = null;
  let logsToProcess = null;

  const logUnexpectedProcessError = async (kind, error) => {
    const normalizedError = error instanceof Error ? error : new Error(String(error));

    console.error(`\n${kind}:`, normalizedError.message);
    logger.error(kind, {
      error: normalizedError.message,
      stack: normalizedError.stack
    });

    if (orchestrator?.isRunning) {
      try {
        await orchestrator.stop();
      } catch (stopError) {
        logger.error(`Failed to stop orchestrator after ${kind}`, {
          error: stopError.message,
          stack: stopError.stack
        });
      }
    }
  };

  process.on('unhandledRejection', reason => {
    void logUnexpectedProcessError('Unhandled promise rejection', reason);
  });

  process.on('uncaughtException', error => {
    void logUnexpectedProcessError('Uncaught exception', error);
  });

  try {
    let orderList = [];
    const configuredFetchInputs = getConfiguredFetchInputs();

    if (configuredFetchInputs || CONFIG.AUTO_FETCH_ORDER_IDS || CONFIG.ORDER_LIST.length === 0) {
      const answers = configuredFetchInputs || await askInteractiveConfig();

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
      if (answers.flowType) {
        console.log(`Flow Type: ${answers.flowType}`);
      }
      if (answers.subType) {
        console.log(`Sub Type: ${answers.subType}`);
      }
      if (answers.orderLimit) {
        console.log(`Limit: ${answers.orderLimit} orders`);
      }
      console.log('========================================\n');

      const qapiResult = await fetchOrderIdsFromQAPI(
        startDateStr,
        endDateStr,
        [answers.merchantId],
        {
          merchantId: answers.merchantId,
          flowType: answers.flowType,
          subType: answers.subType
        }
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

    if (orderList.length > 0) {
      console.log('\n========================================');
      console.log('Running Sequential ART');
      console.log(`Total Orders: ${orderList.length}`);
      console.log('========================================\n');

      const multiplexerPort = parseInt(process.env.MULTIPLEXER_PORT || process.env.PORT || '3001', 10);
      const cliSessionId = `cli-${Date.now()}`;
      const { registry, ready } = startMultiplexerServer(multiplexerPort);
      await ready;
      const dashboardLikeConfig = {
        ...CONFIG,
        MAX_JOURNEY_TIME_MS: 3 * 60 * 1000,
        REPORT_PATH: CONFIG.REPORT_PATH || 'report.json',
        AUTO_FETCH_LOGS: true,
        USE_ASYNC_ORCHESTRATOR: true,
        PORT: multiplexerPort,
        TIMEOUT_MS: 10000,
        LOGS_FILE_PATH: `data/logs-${cliSessionId}.json`,
        MERCHANT_ID: CONFIG.MERCHANT_ID,
        SESSION_TOKEN: process.env.SESSION_TOKEN || '',
        PARALLEL_ORDERS: 10,
        registry,
        getRegistrySessionId: (orderId) => `${cliSessionId}:${orderId}`,
        onOrchestratorReady: (orchestratorInstance, orderId, registrySessionId) => {
          registry.register(registrySessionId, orchestratorInstance, [orderId]);
        },
        onLoanApplicationId: (loanApplicationId, orderId, registrySessionId) => {
          registry.addLoanApplicationId(registrySessionId, loanApplicationId);
        }
      };

      const result = await runSequentialArt(orderList, dashboardLikeConfig);

      console.log('\n========================================');
      console.log('Sequential ART Complete');
      console.log(`Overall Success: ${result.success}`);
      console.log('========================================\n');

      process.exit(result.success ? 0 : 1);
    }

    console.log('Loading logs from file...');
    const logs = await fetchLogsFromJSONFile(CONFIG.LOGS_FILE_PATH);
    console.log(`Loaded ${logs.length} logs`);

    if (logs.length > 0) {
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
      logsToProcess = finalFilteredLogs;
    } else {
      console.log('No logs to process - starting server in standby mode');
    }

    // Start mock services if enabled
    if (MOCK_CONFIG.enabled) {
      console.log('\n🔧 Mock mode enabled - starting mock services...');

      // Derive ports from URLs
      const lspPort = new URL(MOCK_CONFIG.mockLspUrl).port || 4232;
      const gwPort = new URL(MOCK_CONFIG.mockGwUrl).port || 2344;

      mocks = createMockController({
        lspPort: parseInt(lspPort, 10),
        gwPort: parseInt(gwPort, 10),
        orchestratorUrl: `http://localhost:${CONFIG.ART_PORT}`
      });

      await mocks.start(logsToProcess || []);

      // Override service URLs to point to mocks
      SERVICE_MAP.LSP.baseUrl = MOCK_CONFIG.mockLspUrl;
      SERVICE_MAP.GW.baseUrl = MOCK_CONFIG.mockGwUrl;

      console.log('✅ Mock services started:');
      console.log(`   - LSP mock: ${MOCK_CONFIG.mockLspUrl}`);
      console.log(`   - GW mock:  ${MOCK_CONFIG.mockGwUrl}`);
    }

    // Create orchestrator
    const OrchestratorClass = CONFIG.USE_ASYNC_ORCHESTRATOR ? AsyncReplayOrchestrator : ReplayOrchestrator;
    orchestrator = new OrchestratorClass(logsToProcess || [], {
      timeoutMs: CONFIG.TIMEOUT_MS
    });

    if (CONFIG.USE_ASYNC_ORCHESTRATOR) {
      console.log('\n⚡ Using ASYNC orchestrator with buffer system');
    }

    const app = createServer(orchestrator);
    const httpServer = createHttpServer(app);
    const servers = [];

    if (CONFIG.ART_PORT > 0) {
      const tcpServer = app.listen(CONFIG.ART_PORT, () => {
        console.log(`\n🚀 ART Server running on TCP port: ${CONFIG.ART_PORT}`);
        console.log(`   Dashboard/Browser: http://localhost:${CONFIG.ART_PORT}/`);
      });
      servers.push(tcpServer);
    }

    if (CONFIG.ART_UNIX_SOCKET_PATH) {
      const socketDir = dirname(CONFIG.ART_UNIX_SOCKET_PATH);
      if (socketDir && socketDir !== '.') {
        mkdirSync(socketDir, { recursive: true });
      }

      if (existsSync(CONFIG.ART_UNIX_SOCKET_PATH)) {
        try { unlinkSync(CONFIG.ART_UNIX_SOCKET_PATH); } catch {}
      }

      const unixServer = httpServer.listen(CONFIG.ART_UNIX_SOCKET_PATH, () => {
        chmodSync(CONFIG.ART_UNIX_SOCKET_PATH, 0o660);
        console.log(`🚀 ART Server running on Unix socket: ${CONFIG.ART_UNIX_SOCKET_PATH}`);
        console.log(`   Internal IPC: curl --unix-socket ${CONFIG.ART_UNIX_SOCKET_PATH} http://localhost/health`);
      });
      servers.push(unixServer);
    }

    if (servers.length === 0) {
      throw new Error('No listen method configured. Set ART_PORT or ART_UNIX_SOCKET_PATH');
    }

    server = httpServer;

    console.log('\nEndpoints:');
    if (CONFIG.ART_PORT > 0) {
      console.log(`  - TCP:     http://localhost:${CONFIG.ART_PORT}/health`);
    }
    if (CONFIG.ART_UNIX_SOCKET_PATH) {
      console.log(`  - Socket:  curl --unix-socket ${CONFIG.ART_UNIX_SOCKET_PATH} http://localhost/health`);
    }
    console.log('  - Control: POST /control/{start|stop}');
    if (CONFIG.USE_ASYNC_ORCHESTRATOR) {
      console.log('\n⚡ Async orchestrator mode active');
    }
    console.log('\nReplay ready. Call /control/start to begin.\n');

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
          if (CONFIG.ART_UNIX_SOCKET_PATH && existsSync(CONFIG.ART_UNIX_SOCKET_PATH)) {
            try {
              unlinkSync(CONFIG.ART_UNIX_SOCKET_PATH);
              console.log(`🗑️  Socket file cleaned up: ${CONFIG.ART_UNIX_SOCKET_PATH}`);
            } catch (err) {
              console.warn(`⚠️  Could not remove socket on shutdown: ${err.message}`);
            }
          }
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
        server.close(() => {
          if (CONFIG.ART_UNIX_SOCKET_PATH && existsSync(CONFIG.ART_UNIX_SOCKET_PATH)) {
            try {
              unlinkSync(CONFIG.ART_UNIX_SOCKET_PATH);
              console.log(`🗑️  Socket file cleaned up: ${CONFIG.ART_UNIX_SOCKET_PATH}`);
            } catch (err) {
              console.warn(`⚠️  Could not remove socket on shutdown: ${err.message}`);
            }
          }
          process.exit(0);
        });
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
  if (!process.stdin.isTTY) {
    throw new Error('Interactive order fetching requires a TTY. Set LAST_MINUTES, MERCHANT_ID, FLOW_TYPE, SUB_TYPE, and optional QAPI_ORDER_LIMIT in env instead.');
  }

  console.log('\n========================================');
  console.log('ART - Automated Regression Testing');
  console.log('========================================\n');

  const defaultMinutes = Number.isInteger(CONFIG.LAST_MINUTES) && CONFIG.LAST_MINUTES > 0 ? CONFIG.LAST_MINUTES : 1440;
  const minutesBackInput = await askQuestion('How many minutes back should we fetch orders for?', String(defaultMinutes));
  const minutesBack = parseInt(minutesBackInput, 10);
  if (isNaN(minutesBack) || minutesBack <= 0) {
    console.error(`Invalid minutes: "${minutesBackInput}". Must be a positive number.`);
    process.exit(1);
  }

  const merchantId = await askQuestion('Merchant ID', CONFIG.MERCHANT_ID || 'flipkart');
  const flowType = await askQuestion('Flow Type (empty = any)', CONFIG.FLOW_TYPE || '');
  const subType = await askQuestion('Sub Type (empty = any)', CONFIG.SUB_TYPE || '');

  const orderLimitInput = await askQuestion('Max orders to process (empty = no limit)', CONFIG.QAPI_ORDER_LIMIT ? String(CONFIG.QAPI_ORDER_LIMIT) : '');
  const orderLimit = orderLimitInput ? parseInt(orderLimitInput, 10) : null;
  if (orderLimitInput && (isNaN(orderLimit) || orderLimit <= 0)) {
    console.error(`Invalid limit: "${orderLimitInput}". Must be a positive number or empty.`);
    process.exit(1);
  }

  return { minutesBack, merchantId, orderLimit, flowType, subType };
}

// Run main
main();

// Export for testing
export { main };
