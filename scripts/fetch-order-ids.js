#!/usr/bin/env node

import 'dotenv/config';
import { fetchOrderIdsFromQAPI } from '../src/services/http-client.js';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

function parseArgs() {
  const args = process.argv.slice(2);
  const options = {
    startDate: new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString().split('T')[0] + 'T00:00:00Z',
    endDate: new Date().toISOString(),
    merchants: (process.env.QAPI_MERCHANT_ID || 'flipkart').split(','),
    limit: parseInt(process.env.ORDER_LIMIT, 10) || null
  };

  for (const arg of args) {
    if (arg.startsWith('--start=')) {
      options.startDate = arg.split('=')[1];
    } else if (arg.startsWith('--end=')) {
      options.endDate = arg.split('=')[1];
    } else if (arg.startsWith('--merchants=')) {
      options.merchants = arg.split('=')[1].split(',');
    } else if (arg.startsWith('--limit=')) {
      options.limit = parseInt(arg.split('=')[1], 10);
    }
  }

  return options;
}

function updateEnvFile(orderIds) {
  const envPath = path.join(__dirname, '..', '.env');
  let envContent = fs.readFileSync(envPath, 'utf-8');

  const orderListLine = `ORDER_LIST=${orderIds.join(',')}`;

  if (envContent.includes('ORDER_LIST=')) {
    envContent = envContent.replace(/ORDER_LIST=.*/g, orderListLine);
  } else {
    envContent += `\n${orderListLine}\n`;
  }

  fs.writeFileSync(envPath, envContent);
  console.log(`✓ Updated ORDER_LIST in .env with ${orderIds.length} orders`);
}

async function main() {
  const options = parseArgs();

  console.log('\n========================================');
  console.log('Fetching Order IDs from QAPI');
  console.log('========================================');
  console.log(`Start Date: ${options.startDate}`);
  console.log(`End Date: ${options.endDate}`);
  console.log(`Merchants: ${options.merchants.join(', ')}`);
  if (options.limit) {
    console.log(`Limit: ${options.limit} orders`);
  }
  console.log('========================================\n');

  const result = await fetchOrderIdsFromQAPI(
    options.startDate,
    options.endDate,
    options.merchants
  );

  if (!result.success) {
    console.error('✗ Failed to fetch order IDs:', result.error);
    process.exit(1);
  }

  if (result.count === 0) {
    console.log('⚠ No order IDs found for the given criteria');
    process.exit(0);
  }

  console.log(`✓ Fetched ${result.count} orders from QAPI`);
  console.log('\nSample orders:');
  result.orders.slice(0, 5).forEach((o, i) => {
    console.log(`  ${i + 1}. ${o.orderId} (${o.merchantId})`);
  });
  if (result.count > 5) {
    console.log(`  ... and ${result.count - 5} more`);
  }

  let ordersToUse = result.orders;
  if (options.limit && result.count > options.limit) {
    ordersToUse = result.orders.slice(0, options.limit);
    console.log(`\n⚠ Limited to first ${options.limit} orders`);
  }

  const orderIds = ordersToUse.map(o => o.orderId);
  
  updateEnvFile(orderIds);

  console.log('\n========================================');
  console.log('Ready to run ART');
  console.log('========================================');
  console.log('\nNext steps:');
  console.log('  npm start  # or npm run dev');
  console.log('');
}

main().catch(error => {
  console.error('Unexpected error:', error);
  process.exit(1);
});
