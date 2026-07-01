import './bootstrap-env.js';

import { fetchOrderIdsFromQAPI } from './services/http-client.js';
import { writeOrderListFile, writeWorkerOrderListFiles } from './services/order-list.js';

function parseOptionalInt(value, envName) {
  if (value === undefined || value === '') {
    return null;
  }

  const parsed = parseInt(value, 10);
  if (!Number.isInteger(parsed)) {
    throw new Error(`${envName} must be an integer`);
  }

  return parsed;
}

function parseCsv(value) {
  return value
    ? value.split(',').map(item => item.trim()).filter(Boolean)
    : [];
}

function resolveInterval() {
  const explicitStartDate = process.env.QAPI_START_DATE || process.env.START_DATE || null;
  const explicitEndDate = process.env.QAPI_END_DATE || process.env.END_DATE || null;

  if (explicitStartDate && explicitEndDate) {
    return {
      startDate: explicitStartDate,
      endDate: explicitEndDate,
      mode: 'explicit'
    };
  }

  const lastMinutes =
    parseOptionalInt(process.env.LAST_MINUTES, 'LAST_MINUTES') ??
    parseOptionalInt(process.env.QAPI_LOOKBACK_MINUTES, 'QAPI_LOOKBACK_MINUTES') ??
    1440;

  if (lastMinutes <= 0) {
    throw new Error('LAST_MINUTES must be a positive integer');
  }

  const logDelayMinutes = parseOptionalInt(process.env.ORDER_FETCH_LOG_DELAY_MINUTES, 'ORDER_FETCH_LOG_DELAY_MINUTES') ?? 5;
  const endDate = new Date(Date.now() - logDelayMinutes * 60 * 1000);
  const startDate = new Date(endDate.getTime() - lastMinutes * 60 * 1000);

  return {
    startDate: startDate.toISOString(),
    endDate: endDate.toISOString(),
    mode: 'lookback',
    lastMinutes,
    logDelayMinutes
  };
}

async function main() {
  const outputFile = process.env.ORDER_FILE || process.env.MULTI_ART_ORDER_FILE || 'data/order-ids.json';
  const workerCount = parseOptionalInt(process.env.ART_WORKER_COUNT, 'ART_WORKER_COUNT') ?? 1;
  const workerOrderFileTemplate = process.env.ART_WORKER_ORDER_FILE_TEMPLATE || null;
  const merchantIds = parseCsv(process.env.MERCHANT_IDS);
  const merchantId = process.env.MERCHANT_ID || process.env.QAPI_MERCHANT_ID || merchantIds[0] || 'flipkart';
  const resolvedMerchantIds = merchantIds.length > 0 ? merchantIds : [merchantId];
  const orderLimit = parseOptionalInt(process.env.QAPI_ORDER_LIMIT, 'QAPI_ORDER_LIMIT');
  const flowType = process.env.FLOW_TYPE || 'NTB';
  const subType = process.env.SUB_TYPE || 'CHECKOUT';
  const interval = resolveInterval();

  console.log('\n========================================');
  console.log('Fetching ART Order IDs');
  console.log('========================================');
  console.log(`Output File: ${outputFile}`);
  console.log(`Merchant IDs: ${resolvedMerchantIds.join(', ')}`);
  console.log(`Date Range: ${interval.startDate} to ${interval.endDate}`);
  if (interval.mode === 'lookback') {
    console.log(`Lookback: ${interval.lastMinutes} minutes`);
    console.log(`Log Delay Offset: ${interval.logDelayMinutes} minutes`);
  }
  if (flowType) console.log(`Flow Type: ${flowType}`);
  if (subType) console.log(`Sub Type: ${subType}`);
  if (orderLimit) console.log(`Limit: ${orderLimit} orders`);
  if (workerCount > 1) console.log(`ART Workers: ${workerCount}`);
  if (workerOrderFileTemplate) console.log(`Worker Order File Template: ${workerOrderFileTemplate}`);
  console.log('========================================\n');

  const qapiResult = await fetchOrderIdsFromQAPI(
    interval.startDate,
    interval.endDate,
    resolvedMerchantIds,
    {
      merchantId,
      flowType,
      subType
    }
  );

  if (!qapiResult.success) {
    throw new Error(`Failed to fetch order IDs: ${qapiResult.error}`);
  }

  let orders = Array.isArray(qapiResult.orders) ? qapiResult.orders : [];
  if (orderLimit && orders.length > orderLimit) {
    orders = orders.slice(0, orderLimit);
  }

  const writeResult = await writeOrderListFile(outputFile, orders, {
    merchantId,
    merchantIds: resolvedMerchantIds,
    source: 'qapi',
    startDate: interval.startDate,
    endDate: interval.endDate,
    flowType,
    subType
  });

  let workerWriteResults = [];
  if (workerCount > 1 && workerOrderFileTemplate) {
    workerWriteResults = await writeWorkerOrderListFiles(workerOrderFileTemplate, writeResult.orders, workerCount, {
      merchantId,
      merchantIds: resolvedMerchantIds,
      source: 'qapi-split',
      parentOrderFile: writeResult.path,
      startDate: interval.startDate,
      endDate: interval.endDate,
      flowType,
      subType
    });
  }

  console.log('\n========================================');
  console.log('ART Order ID Fetch Complete');
  console.log('========================================');
  console.log(`Orders Written: ${writeResult.count}`);
  console.log(`Order File: ${writeResult.path}`);
  writeResult.orders.slice(0, 5).forEach((order, index) => {
    console.log(`  ${index + 1}. ${order.orderId} (${order.merchantId})`);
  });
  if (writeResult.orders.length > 5) {
    console.log(`  ... and ${writeResult.orders.length - 5} more`);
  }
  if (workerWriteResults.length > 0) {
    console.log('\nWorker Order Files:');
    workerWriteResults.forEach((result, index) => {
      console.log(`  Worker ${index}: ${result.count} orders -> ${result.path}`);
    });
  }
  console.log('========================================\n');
}

main().catch(error => {
  console.error('Failed to fetch ART order IDs:', error.message);
  console.error(error.stack);
  process.exit(1);
});
