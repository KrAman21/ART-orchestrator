import './bootstrap-env.js';
import { uninstallEarlyProcessComposeStop } from './utils/early-process-compose-stop.js';
import './utils/art-log-output.js';

import { readFileSync } from 'fs';
import { createInterface } from 'readline';
import { logger } from './utils/logger.js';
import { runSequentialArt } from './sequential-runner.js';
import { fetchOrderIdsFromQAPI } from './services/http-client.js';
import { startMultiplexerServer } from './dashboard/multiplexer.js';
import { stopProcessCompose } from './utils/process-compose.js';

uninstallEarlyProcessComposeStop();

const CONFIG = {
  ART_UNIX_SOCKET_PATH: process.env.ART_UNIX_SOCKET_PATH || null,
  LOGS_FILE_PATH: process.env.LOGS_FILE_PATH || 'data/logs.json',
  TIMEOUT_MS: parseInt(process.env.TIMEOUT_MS, 10) || 10000,
  AUTO_START: process.env.AUTO_START !== 'false',
  USE_ASYNC_ORCHESTRATOR: process.env.USE_ASYNC_ORCHESTRATOR === 'true',
  AUTO_FETCH_LOGS: process.env.AUTO_FETCH_LOGS === 'true',
  AUTO_FETCH_ORDER_IDS: process.env.AUTO_FETCH_ORDER_IDS === 'true',
  QAPI_LOOKBACK_MINUTES: parseInt(process.env.QAPI_LOOKBACK_MINUTES, 10) || null,
  QAPI_ORDER_LIMIT: parseInt(process.env.QAPI_ORDER_LIMIT, 10) || null,
  MERCHANT_ID: process.env.MERCHANT_ID || process.env.QAPI_MERCHANT_ID || 'flipkart',
  FILTERED_LOGS_PATH: process.env.FILTERED_LOGS_PATH || 'data/filtered-logs.json',
  FINAL_FILTERED_LOGS_PATH: process.env.FINAL_FILTERED_LOGS_PATH || 'data/final-filtered-logs.json',
  ORDER_LIST: process.env.ORDER_LIST 
    ? process.env.ORDER_LIST.split(',').map(s => s.trim()).filter(Boolean)
    : [],
  FLOW_TYPE: process.env.FLOW_TYPE || 'NTB',
  SUB_TYPE: process.env.SUB_TYPE || 'CHECKOUT',
  LAST_MINUTES: process.env.LAST_MINUTES ? parseInt(process.env.LAST_MINUTES, 10) : null,
  SESSION_TOKEN: process.env.SESSION_TOKEN || '',
  REPORT_PATH: process.env.REPORT_PATH || 'report.json',
  KEEP_ORDER_TEMP_FILES: process.env.KEEP_ORDER_TEMP_FILES === 'true',
  ENABLE_BATCH_PROCESSING: process.env.ENABLE_BATCH_PROCESSING !== 'false',
  OPTIONAL_REPEAT_LOG_TAGS: process.env.OPTIONAL_REPEAT_LOG_TAGS
    ? process.env.OPTIONAL_REPEAT_LOG_TAGS.split(',').map(s => s.trim()).filter(Boolean)
    : [],
  OPTIONAL_REPEAT_AFTER_SECONDS: process.env.OPTIONAL_REPEAT_AFTER_SECONDS
    ? parseInt(process.env.OPTIONAL_REPEAT_AFTER_SECONDS, 10)
    : 5
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

async function resolveOrderList() {
  if (CONFIG.ORDER_LIST.length > 0) {
    console.log('\n========================================');
    console.log('Using Explicit ORDER_LIST');
    console.log('========================================');
    CONFIG.ORDER_LIST.forEach((orderId, index) => {
      console.log(`  ${index + 1}. ${orderId} (${CONFIG.MERCHANT_ID})`);
    });
    console.log('========================================\n');

    return CONFIG.ORDER_LIST.map((orderId) => ({
      merchantId: CONFIG.MERCHANT_ID,
      orderId
    }));
  }

  const configuredFetchInputs = getConfiguredFetchInputs();

  if (configuredFetchInputs) {
    const answers = configuredFetchInputs;
    const minutesBack = answers.minutesBack;
    const logDelayMinutes = 5;
    const endDate = new Date(Date.now() - logDelayMinutes * 60 * 1000);
    const startDate = new Date(endDate.getTime() - minutesBack * 60 * 1000);
    const startDateStr = startDate.toISOString();
    const endDateStr = endDate.toISOString();

    console.log('\n========================================');
    console.log('Fetching Order IDs from QAPI');
    console.log('========================================');
    console.log(`Merchant: ${answers.merchantId}`);
    console.log(`Lookback: ${minutesBack} minutes`);
    console.log(`Log Delay Offset: ${logDelayMinutes} minutes`);
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
      throw new Error(`Failed to fetch order IDs: ${qapiResult.error}`);
    }

    if (qapiResult.count === 0) {
      console.log('No order IDs found from QAPI');
      return [];
    }

    let orders = qapiResult.orders;
    if (answers.orderLimit && orders.length > answers.orderLimit) {
      orders = orders.slice(0, answers.orderLimit);
      console.log(`Limited to first ${answers.orderLimit} orders`);
    }

    const orderList = orders.map((order) => ({
      merchantId: order.merchantId,
      orderId: order.orderId
    }));

    console.log(`Fetched ${orderList.length} orders from QAPI`);
    console.log('\nSample orders:');
    orderList.slice(0, 5).forEach((order, index) => {
      console.log(`  ${index + 1}. ${order.orderId} (${order.merchantId})`);
    });
    if (orderList.length > 5) {
      console.log(`  ... and ${orderList.length - 5} more`);
    }
    console.log('');

    return orderList;
  }

  const answers = await askInteractiveConfig();
  return answers.orderList.map((orderId) => ({
    merchantId: answers.merchantId,
    orderId
  }));
}

async function main() {
  const logUnexpectedProcessError = async (kind, error) => {
    const normalizedError = error instanceof Error ? error : new Error(String(error));

    console.error(`\n${kind}:`, normalizedError.message);
    logger.error(kind, {
      error: normalizedError.message,
      stack: normalizedError.stack
    });

    await stopProcessCompose(kind);
  };

  process.on('unhandledRejection', reason => {
    void logUnexpectedProcessError('Unhandled promise rejection', reason).finally(() => {
      process.exit(1);
    });
  });

  process.on('uncaughtException', error => {
    void logUnexpectedProcessError('Uncaught exception', error).finally(() => {
      process.exit(1);
    });
  });

  try {
    const orderList = await resolveOrderList();

    if (orderList.length === 0) {
      process.exit(0);
    }

    console.log('\n========================================');
    console.log('Running Sequential ART');
    console.log(`Total Orders: ${orderList.length}`);
    console.log('========================================\n');

    const { registry, ready, unixServer } = startMultiplexerServer();
    await ready;

    if (unixServer) {
      unixServer.on('error', (error) => {
        void stopProcessCompose(`ART unix server error: ${error.message}`);
      });

      unixServer.on('close', () => {
        void stopProcessCompose('ART unix server closed');
      });
    }

    const sessionId = 'cli-' + Date.now();
    const cliConfig = {
      ...CONFIG,
      MAX_JOURNEY_TIME_MS: 3 * 60 * 1000,
      AUTO_FETCH_LOGS: true,
      USE_ASYNC_ORCHESTRATOR: true,
      registry,
      sessionId,
      getRegistrySessionId: (orderId) => sessionId + ':' + orderId,
      onOrchestratorReady: (orchestrator, orderId, registrySessionId) => {
        registry.register(registrySessionId, orchestrator, [orderId]);
      },
      onLoanApplicationId: (loanApplicationId, orderId, registrySessionId) => {
        registry.addLoanApplicationId(registrySessionId, loanApplicationId);
      }
    };

    const result = await runSequentialArt(orderList, cliConfig);

    console.log('\n========================================');
    console.log('Sequential ART Complete');
    console.log(`Overall Success: ${result.success}`);
    console.log(`ART Report Path: ${CONFIG.REPORT_PATH}`);
    console.log('Stopping process-compose services...');
    console.log('========================================\n');
    console.log('ART Report Content Start');
    console.log(readFileSync(CONFIG.REPORT_PATH, 'utf-8'));
    console.log('ART Report Content End');
    await stopProcessCompose('ART_RUN_COMPLETED');
    process.exit(result.success ? 0 : 1);
  } catch (error) {
    console.error('Failed to start:', error.message);
    console.error(error.stack);
    await stopProcessCompose(`Failed to start: ${error.message}`);
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
    throw new Error('No LAST_MINUTES or ORDER_LIST configured. Set LAST_MINUTES for QAPI fetch mode, or ORDER_LIST for direct replay.');
  }

  console.log('\n========================================');
  console.log('ART - Automated Regression Testing');
  console.log('========================================\n');

  const defaultMinutes = CONFIG.QAPI_START_DATE ? 10080 : 1440;
  const minutesBackInput = CONFIG.QAPI_LOOKBACK_MINUTES
    ? String(CONFIG.QAPI_LOOKBACK_MINUTES)
    : await askQuestion('How many minutes back should we fetch orders for?', String(defaultMinutes));
  const minutesBack = parseInt(minutesBackInput, 10);
  if (isNaN(minutesBack) || minutesBack <= 0) {
    console.error(`Invalid minutes: "${minutesBackInput}". Must be a positive number.`);
    process.exit(1);
  }

  const merchantId = process.env.MERCHANT_ID || process.env.QAPI_MERCHANT_ID
    ? CONFIG.MERCHANT_ID
    : await askQuestion('Merchant ID', CONFIG.MERCHANT_ID || 'flipkart');

  const orderLimitInput = process.env.QAPI_ORDER_LIMIT
    ? String(CONFIG.QAPI_ORDER_LIMIT)
    : await askQuestion('Max orders to process (empty = no limit)', CONFIG.QAPI_ORDER_LIMIT ? String(CONFIG.QAPI_ORDER_LIMIT) : '');
  const orderLimit = orderLimitInput ? parseInt(orderLimitInput, 10) : null;
  if (orderLimitInput && (isNaN(orderLimit) || orderLimit <= 0)) {
    console.error(`Invalid limit: "${orderLimitInput}". Must be a positive number or empty.`);
    process.exit(1);
  }

  return { minutesBack, merchantId, orderLimit };
}

main();

export { main };
