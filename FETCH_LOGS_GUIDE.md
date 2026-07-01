# S3 Trace Logs Fetcher

This feature allows you to automatically fetch S3 trace logs from the LSP API for a list of order IDs, storing them in `data/logs.json` for ART processing.

## Overview

When ART starts, it reads logs from `data/logs.json`. The fetcher automates the process of:
1. Taking a list of order IDs and merchant IDs
2. Calling the S3 Trace Logs API for each order
3. Combining all logs into a single file
4. Saving to `data/logs.json` for ART to process

## Quick Start

### 1. Set Your Session Token

You have three options:

**Option A: Environment Variable (Recommended)**
```bash
export SESSION_TOKEN=LSP1178f1ff59564770b13ba13f7bb66797
```

**Option B: Update .env File**
Edit `/home/kumar-aman/Desktop/repos/art-orchestrator/.env`:
```
SESSION_TOKEN=LSP1178f1ff59564770b13ba13f7bb66797
```

**Option C: Command Line Argument**
Pass `--session-token` with each command (see examples below).

### 2. Fetch Logs

**Single Order:**
```bash
npm run fetch-logs -- --merchant flipkart --orders 1778495817
```

**Multiple Orders:**
```bash
npm run fetch-logs -- --merchant flipkart --orders 1778495817,1778495818,1778495819
```

**From JSON File:**
```bash
# Create orders.json file
[
  "1778495817",
  "1778495818",
  "1778495819"
]

# Then run
npm run fetch-logs -- --merchant flipkart --orders-file orders.json
```

### 3. Run ART

Once logs are fetched, ART will automatically process them:
```bash
npm start
```

## CLI Options

| Option | Alias | Description | Default |
|--------|-------|-------------|---------|
| `--help` | `-h` | Show help message | - |
| `--merchant` | `-m` | Merchant ID | `flipkart` |
| `--orders` | `-o` | Comma-separated order IDs | - |
| `--orders-file` | `-f` | Path to JSON file with order IDs | - |
| `--session-token` | `-s` | Session token for API | `$SESSION_TOKEN` |
| `--output` | `-p` | Output file path | `data/logs.json` |
| `--delay` | `-d` | Delay between requests (ms) | `500` |
| `--retries` | `-r` | Max retries per order | `3` |

## Advanced Usage

### Custom Output Path

```bash
npm run fetch-logs -- \
  --merchant flipkart \
  --orders 1778495817 \
  --output data/my-custom-logs.json
```

### Adjust Rate Limiting

If you experience rate limiting, increase the delay:
```bash
npm run fetch-logs -- \
  --merchant flipkart \
  --orders-file orders.json \
  --delay 1000 \
  --retries 5
```

### Programmatic Usage

```javascript
import { S3TraceLogsFetcher, fetchS3TraceLogsForOrders } from './src/utils/s3-trace-logs-fetcher.js';

// Method 1: Using the class
const fetcher = new S3TraceLogsFetcher({
  sessionToken: 'LSPxxxxx',
  outputPath: 'data/logs.json',
  delayBetweenRequests: 500,
  maxRetries: 3
});

const orders = [
  { merchantId: 'flipkart', orderId: '1778495817' },
  { merchantId: 'flipkart', orderId: '1778495818' }
];

const result = await fetcher.fetchLogsForOrders(orders);
console.log(`Fetched ${result.stats.totalLogs} logs`);

// Method 2: Using the convenience function
const result2 = await fetchS3TraceLogsForOrders(orders, {
  sessionToken: 'LSPxxxxx',
  outputPath: 'data/logs.json'
});
```

### Helper Methods

```javascript
// Create order list from merchant ID and order IDs
const orders = S3TraceLogsFetcher.createOrderList('flipkart', ['1778495817', '1778495818']);
// Result: [{ merchantId: 'flipkart', orderId: '1778495817' }, ...]

// Create order list with defaults
const ordersWithDefaults = S3TraceLogsFetcher.createOrderListWithDefaults(
  [{ orderId: '1778495817' }, { merchantId: 'flipkart', orderId: '1778495818' }],
  'flipkart'  // default merchant
);
```

## Environment Variables

| Variable | Description | Default |
|----------|-------------|---------|
| `SESSION_TOKEN` | Authentication token for S3 Trace Logs API | `your_session_token_here` |
| `LOGS_FILE_PATH` | Default output path for logs | `data/logs.json` |
| `USE_FETCH_ORDER_CONTEXT` | Use LSP `/art/order-context/fetch` to discover loan application IDs before fetching loan-application S3 logs. Set to `false` to derive unique loan application IDs from the order S3 logs instead. | `true` |
| `USE_ART_FINAL_STORE_LOGS` | Load cron-produced `final-filtered-logs.json` files and skip ART worker log fetching/filtering | `false` |
| `ART_FINAL_STORE_DIR` | Directory containing cron final-log artifacts when `USE_ART_FINAL_STORE_LOGS=true` | `data/art-final-store` |
| `ART_FINAL_STORE_ORDER_LIST_PATH` | Optional order-list handoff file written by cron; defaults to `$ART_FINAL_STORE_DIR/latest-order-list.json` | unset |
| `LSP_API_BASE_URL` | Base URL for the LSP API | `https://integ-expresscheckout-api.juspay.in` |

## Error Handling

The fetcher implements robust error handling:

1. **Automatic Retries**: Failed requests are retried up to 3 times (configurable) with exponential backoff
2. **Partial Success**: If some orders fail, successfully fetched logs are still saved
3. **Detailed Logging**: All API calls and errors are logged
4. **Rate Limiting**: Configurable delay between requests to prevent overwhelming the API

## Output

The fetcher produces:

1. **log.json file**: Combined logs from all orders (sorted by timestamp)
2. **Console output**: Progress updates and summary statistics
3. **Return object**: Detailed results including success/failure counts

Example output:
```
========================================
Fetch Summary
========================================
Total Orders:   3
Successful:     3
Failed:         0
Total Logs:     156
Output File:    data/logs.json
File Saved:     Yes
Overall Status: SUCCESS
========================================
```

## Integration with ART

ART automatically reads logs from the configured path (default: `data/logs.json`). After fetching:

```bash
# 1. Fetch logs
npm run fetch-logs -- --merchant flipkart --orders-file orders.json

# 2. Start ART
npm start

# ART will now process the fetched logs
```

## API Details

The fetcher calls:
- **Endpoint**: `GET /credit/api/v3.3/dashboard/getS3TraceLogs`
- **Base URL**: `https://integ-expresscheckout-api.juspay.in`
- **Query Parameters**:
  - `lookup_on=SECONDARY`
  - `id={merchant_id}/{order_id}`
  - `id_type=merchant_id/order_id`
- **Headers**:
  - `Content-Type: application/json`
  - `Accept: application/json`
  - `session-token: {SESSION_TOKEN}`

## Troubleshooting

**No session token provided**
- Set `SESSION_TOKEN` environment variable
- Or pass `--session-token` flag

**API returns 401/403**
- Check that your session token is valid and not expired
- Verify token has access to the S3 Trace Logs endpoint

**Rate limiting (429)**
- Increase `--delay` parameter
- Reduce number of concurrent requests

**Empty logs returned**
- Verify order ID exists in the system
- Check merchant ID is correct
- Ensure order has associated trace logs

**Connection errors**
- Check network connectivity to `integ-expresscheckout-api.juspay.in`
- Verify firewall/proxy settings allow the connection
