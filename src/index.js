import { runOrchestrator } from './orchestrator.js';
import {
  fetchLogsFromAPI,
  fetchLogsFromJSONFile,
  fetchOrderIdsFromClickHouse
} from './services/log-fetcher.js';

// Configuration - can be overridden via environment variables
const CONFIG = {
  // API endpoint that returns logs JSON (populated from ClickHouse/S3)
  LOGS_API_URL: process.env.LOGS_API_URL || 'http://localhost:3000/api/logs',

  // Alternative: Local JSON file path (relative to repo root)
  LOGS_FILE_PATH: process.env.LOGS_FILE_PATH || 'data/logs.json',

  // API to fetch order IDs from ClickHouse
  CLICKHOUSE_API_URL: process.env.CLICKHOUSE_API_URL || 'http://localhost:3000/api/order-ids',

  // Use local JSON file instead of API (set to 'true' to use local file)
  USE_JSON_FILE: process.env.USE_JSON_FILE === 'true'
};

/**
 * Main execution flow
 */
async function main() {
  try {
    let logs;

    if (CONFIG.USE_JSON_FILE) {
      // Option 1: Read from local JSON file in repo
      console.log('Reading logs from local JSON file...');
      logs = await fetchLogsFromJSONFile(CONFIG.LOGS_FILE_PATH);
    } else {
      // Option 2: Fetch order IDs from ClickHouse, then fetch logs
      console.log('Fetching order IDs from ClickHouse...');
      const orderIds = await fetchOrderIdsFromClickHouse(CONFIG.CLICKHOUSE_API_URL, {
        // Add filters here if needed
        // startDate: '2026-04-01',
        // endDate: '2026-04-07',
        // limit: 100
      });

      if (orderIds.length === 0) {
        console.log('No order IDs found');
        return;
      }

      console.log('Fetching logs for order IDs:', orderIds.join(', '));
      logs = await fetchLogsFromAPI(CONFIG.LOGS_API_URL, orderIds);
    }

    if (logs.length === 0) {
      console.log('No logs to process');
      return;
    }

    console.log(`\nStarting ART replay with ${logs.length} logs...\n`);

    const results = await runOrchestrator(logs);

    console.log('\n=== Replay Summary ===');
    console.log(JSON.stringify(results, null, 2));

    // Exit with appropriate code
    process.exit(results.success ? 0 : 1);

  } catch (error) {
    console.error('Failed:', error.message);
    process.exit(1);
  }
}

// Run if called directly
if (import.meta.url === `file://${process.argv[1]}`) {
  main();
}

// Export for testing or programmatic use
export { main };
