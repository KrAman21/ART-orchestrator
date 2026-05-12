#!/usr/bin/env node

import 'dotenv/config';
import { BatchLogFetcher, fetchLogsForOrders } from '../src/log-fetcher/index.js';

function showUsage() {
  console.log(`
Usage: node scripts/fetch-logs.js [options]

Options:
  --help, -h              Show this help message
  --merchant, -m          Merchant ID (default: flipkart)
  --orders, -o            Comma-separated list of order IDs
  --orders-file, -f       Path to JSON file containing order IDs array
  --session-token, -s     Session token (overrides env var)
  --output, -p            Output file path (default: logs/s3-fetched-logs/logs.json)
  --delay, -d             Delay between requests in ms (default: 500)
  --retries, -r           Max retries per order (default: 3)

Examples:
  # Fetch logs for single order
  node scripts/fetch-logs.js --merchant flipkart --orders 1778495817

  # Fetch logs for multiple orders
  node scripts/fetch-logs.js --merchant flipkart --orders 1778495817,1778495818,1778495819

  # Fetch logs from file
  node scripts/fetch-logs.js --merchant flipkart --orders-file ./orders.json

  # With custom session token
  node scripts/fetch-logs.js --merchant flipkart --orders 1778495817 --session-token LSPxxxxxx

  # Copy to data directory for ART
  node scripts/fetch-logs.js --merchant flipkart --orders 1778495817 --output data/logs.json

Environment Variables:
  SESSION_TOKEN           Session token for API authentication
  LOG_OUTPUT_PATH         Default output path for logs (default: logs/s3-fetched-logs/logs.json)
`);
}

function parseArgs(args) {
  const options = {
    merchantId: 'flipkart',
    orders: [],
    sessionToken: process.env.SESSION_TOKEN || '',
    outputPath: process.env.LOG_OUTPUT_PATH || 'logs/s3-fetched-logs/logs.json',
    delayBetweenRequests: 500,
    maxRetries: 3
  };

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    const nextArg = args[i + 1];

    switch (arg) {
      case '--help':
      case '-h':
        showUsage();
        process.exit(0);
        break;
      case '--merchant':
      case '-m':
        options.merchantId = nextArg;
        i++;
        break;
      case '--orders':
      case '-o':
        options.orders = nextArg.split(',').map(o => o.trim()).filter(Boolean);
        i++;
        break;
      case '--orders-file':
      case '-f':
        options.ordersFile = nextArg;
        i++;
        break;
      case '--session-token':
      case '-s':
        options.sessionToken = nextArg;
        i++;
        break;
      case '--output':
      case '-p':
        options.outputPath = nextArg;
        i++;
        break;
      case '--delay':
      case '-d':
        options.delayBetweenRequests = parseInt(nextArg, 10);
        i++;
        break;
      case '--retries':
      case '-r':
        options.maxRetries = parseInt(nextArg, 10);
        i++;
        break;
    }
  }

  return options;
}

async function loadOrdersFromFile(filePath) {
  try {
    const fs = await import('fs/promises');
    const content = await fs.readFile(filePath, 'utf-8');
    const orders = JSON.parse(content);
    if (Array.isArray(orders)) {
      return orders.map(o => typeof o === 'string' ? o : o.orderId || o.id);
    }
    throw new Error('Orders file must contain an array');
  } catch (error) {
    console.error(`Error loading orders file: ${error.message}`);
    process.exit(1);
  }
}

async function main() {
  const args = process.argv.slice(2);

  if (args.length === 0) {
    showUsage();
    process.exit(0);
  }

  const options = parseArgs(args);

  let orderIds = options.orders;

  if (options.ordersFile) {
    orderIds = await loadOrdersFromFile(options.ordersFile);
  }

  if (orderIds.length === 0) {
    console.error('Error: No orders specified. Use --orders or --orders-file');
    process.exit(1);
  }

  if (!options.sessionToken) {
    console.error('Error: Session token not provided. Use --session-token or set SESSION_TOKEN env var');
    process.exit(1);
  }

  const orderList = BatchLogFetcher.createOrderList(options.merchantId, orderIds);

  console.log(`\n========================================`);
  console.log(`Fetching S3 Trace Logs`);
  console.log(`========================================`);
  console.log(`Merchant ID:    ${options.merchantId}`);
  console.log(`Order Count:    ${orderList.length}`);
  console.log(`Output Path:    ${options.outputPath}`);
  console.log(`Session Token:  ${options.sessionToken.substring(0, 10)}...`);
  console.log(`========================================\n`);

  const fetcher = new BatchLogFetcher({
    sessionToken: options.sessionToken,
    outputPath: options.outputPath,
    delayBetweenRequests: options.delayBetweenRequests,
    maxRetries: options.maxRetries
  });

  const result = await fetcher.fetchLogsForOrders(orderList);

  console.log(`\n========================================`);
  console.log(`Fetch Summary`);
  console.log(`========================================`);
  console.log(`Total Orders:   ${result.stats.total}`);
  console.log(`Successful:     ${result.stats.successful}`);
  console.log(`Failed:         ${result.stats.failed}`);
  console.log(`Total Logs:     ${result.stats.totalLogs}`);
  console.log(`Output File:    ${result.outputPath}`);
  console.log(`File Saved:     ${result.saved ? 'Yes' : 'No'}`);
  console.log(`Overall Status: ${result.success ? 'SUCCESS' : 'PARTIAL_FAILURE'}`);
  console.log(`========================================\n`);

  process.exit(result.success ? 0 : 1);
}

main().catch(error => {
  console.error('Fatal error:', error);
  process.exit(1);
});
