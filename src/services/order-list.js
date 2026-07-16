import { mkdir, readFile, writeFile } from 'fs/promises';
import { dirname, resolve } from 'path';

function normalizeOrderEntry(entry, defaultMerchantId) {
  if (typeof entry === 'string' || typeof entry === 'number') {
    const orderId = String(entry).trim();
    return orderId ? { merchantId: defaultMerchantId, orderId } : null;
  }

  if (!entry || typeof entry !== 'object') {
    return null;
  }

  const orderId = entry.orderId || entry.order_id || entry.ORDER_ID || entry.id || null;
  const merchantId = entry.merchantId || entry.merchant_id || entry.MERCHANT_ID || defaultMerchantId;

  if (!orderId || String(orderId).trim() === '') {
    return null;
  }

  return {
    merchantId,
    orderId: String(orderId).trim()
  };
}

export function normalizeOrderList(value, defaultMerchantId = 'flipkart') {
  const rawOrders = Array.isArray(value)
    ? value
    : Array.isArray(value?.orders)
      ? value.orders
      : Array.isArray(value?.orderIds)
        ? value.orderIds
        : [];

  const orders = [];
  const seen = new Set();

  for (const entry of rawOrders) {
    const order = normalizeOrderEntry(entry, defaultMerchantId);
    if (!order) continue;

    const dedupeKey = `${order.merchantId}:${order.orderId}`;
    if (seen.has(dedupeKey)) continue;

    seen.add(dedupeKey);
    orders.push(order);
  }

  return orders;
}

export async function loadOrderListFromFile(filePath, defaultMerchantId = 'flipkart') {
  const absolutePath = resolve(process.cwd(), filePath);
  const content = await readFile(absolutePath, 'utf-8');
  const parsed = JSON.parse(content);
  return normalizeOrderList(parsed, defaultMerchantId);
}

export async function writeOrderListFile(filePath, orders, metadata = {}) {
  const normalizedOrders = normalizeOrderList(orders, metadata.merchantId || 'flipkart');
  const absolutePath = resolve(process.cwd(), filePath);

  await mkdir(dirname(absolutePath), { recursive: true });
  await writeFile(
    absolutePath,
    JSON.stringify({
      generatedAt: new Date().toISOString(),
      count: normalizedOrders.length,
      ...metadata,
      orders: normalizedOrders
    }, null, 2),
    'utf-8'
  );

  return {
    path: absolutePath,
    count: normalizedOrders.length,
    orders: normalizedOrders
  };
}

export async function writeWorkerOrderListFiles(filePathTemplate, orders, workerCount, metadata = {}) {
  if (!Number.isInteger(workerCount) || workerCount <= 0) {
    throw new Error('ART_WORKER_COUNT must be a positive integer');
  }

  if (!filePathTemplate || !filePathTemplate.includes('{index}')) {
    throw new Error('ART_WORKER_ORDER_FILE_TEMPLATE must include {index}');
  }

  const normalizedOrders = normalizeOrderList(orders, metadata.merchantId || 'flipkart');
  const baseSize = Math.floor(normalizedOrders.length / workerCount);
  const remainder = normalizedOrders.length % workerCount;
  const results = [];
  let offset = 0;

  for (let workerIndex = 0; workerIndex < workerCount; workerIndex += 1) {
    const size = baseSize + (workerIndex < remainder ? 1 : 0);
    const workerOrders = normalizedOrders.slice(offset, offset + size);
    offset += size;

    const workerFilePath = filePathTemplate.replaceAll('{index}', String(workerIndex));
    const writeResult = await writeOrderListFile(workerFilePath, workerOrders, {
      ...metadata,
      workerIndex,
      workerCount,
      source: metadata.source || 'qapi-split'
    });

    results.push(writeResult);
  }

  return results;
}

export function shardOrderList(orders, workerIndex, workerCount) {
  if (!Number.isInteger(workerCount) || workerCount <= 0) {
    throw new Error('ART_WORKER_COUNT must be a positive integer');
  }

  if (!Number.isInteger(workerIndex) || workerIndex < 0 || workerIndex >= workerCount) {
    throw new Error('ART_WORKER_INDEX must be an integer between 0 and ART_WORKER_COUNT - 1');
  }

  return orders.filter((_, index) => index % workerCount === workerIndex);
}
