import 'dotenv/config';

import { createInterface } from 'readline';
import { logger } from './utils/logger.js';
import { runSequentialArt } from './sequential-runner.js';
import { fetchOrderIdsFromQAPI } from './services/http-client.js';
import { startMultiplexerServer } from './dashboard/multiplexer.js';

const CONFIG = {
  LAST_MINUTES: process.env.LAST_MINUTES ? parseInt(process.env.LAST_MINUTES, 10) : null,
  QAPI_ORDER_LIMIT: parseInt(process.env.QAPI_ORDER_LIMIT, 10) || null,
  MERCHANT_ID: process.env.MERCHANT_ID || 'flipkart',
  FLOW_TYPE: process.env.FLOW_TYPE || '',
  SUB_TYPE: process.env.SUB_TYPE || '',
  ORDER_LIST: process.env.ORDER_LIST
    ? process.env.ORDER_LIST.split(',').map(s => s.trim()).filter(Boolean)
    : [],
  SESSION_TOKEN: process.env.SESSION_TOKEN || '',
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

async function resolveOrderList() {
  const configuredFetchInputs = getConfiguredFetchInputs();

  if (configuredFetchInputs) {
    const answers = configuredFetchInputs;
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

  if (CONFIG.ORDER_LIST.length > 0) {
    return CONFIG.ORDER_LIST.map((orderId) => ({
      merchantId: CONFIG.MERCHANT_ID,
      orderId
    }));
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
  };

  process.on('unhandledRejection', reason => {
    void logUnexpectedProcessError('Unhandled promise rejection', reason);
  });

  process.on('uncaughtException', error => {
    void logUnexpectedProcessError('Uncaught exception', error);
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

    const multiplexerPort = parseInt(process.env.MULTIPLEXER_PORT || process.env.PORT || '3001', 10);
    const cliSessionId = `cli-${Date.now()}`;
    const { registry, ready } = startMultiplexerServer(multiplexerPort);
    await ready;

    const dashboardLikeConfig = {
      MAX_JOURNEY_TIME_MS: 3 * 60 * 1000,
      REPORT_PATH: CONFIG.REPORT_PATH,
      AUTO_FETCH_LOGS: true,
      USE_ASYNC_ORCHESTRATOR: true,
      PORT: multiplexerPort,
      TIMEOUT_MS: 10000,
      LOGS_FILE_PATH: `data/logs-${cliSessionId}.json`,
      MERCHANT_ID: CONFIG.MERCHANT_ID,
      SESSION_TOKEN: CONFIG.SESSION_TOKEN,
      PARALLEL_ORDERS: 10,
      KEEP_ORDER_TEMP_FILES: CONFIG.KEEP_ORDER_TEMP_FILES,
      ENABLE_BATCH_PROCESSING: CONFIG.ENABLE_BATCH_PROCESSING,
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
  } catch (error) {
    console.error('Failed to start:', error.message);
    console.error(error.stack);
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

  const orderListInput = await askQuestion('Order IDs (comma-separated)', CONFIG.ORDER_LIST.join(','));
  const orderList = orderListInput.split(',').map(s => s.trim()).filter(Boolean);
  if (orderList.length === 0) {
    throw new Error('At least one order ID is required when LAST_MINUTES is not configured');
  }

  const merchantId = await askQuestion('Merchant ID', CONFIG.MERCHANT_ID || 'flipkart');
  return { merchantId, orderList };
}

main();

export { main };
