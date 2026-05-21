import { readFile, writeFile } from 'fs/promises';
import { resolve } from 'path';

function shouldSkipLog(log) {
  const msg = log?.message || {};
  const traceRoute = msg.trace_route || '';
  const logTag = (msg.log_tag || '').trim();
  
  if (traceRoute.startsWith('WRAPPER_') || traceRoute.endsWith('_WRAPPER')) {
    if (traceRoute === 'APP_WRAPPER') {
      return false;
    }
    return true;
  }
  
  if (logTag.includes('_ENCRYPTED')) {
    return true;
  }
  
  if (!logTag || logTag === '') {
    return true;
  }
  
  return false;
}

/**
 * Perform second-level filtering to remove entries that orchestrator would skip
 * This ensures final-filtered logs only contain actionable entries
 * @param {Array} logs - Logs after first-level filtering
 * @param {string} outputPath - Optional path to save final filtered logs (e.g., 'data/final-filtered-logs.json')
 * @returns {Array} - Logs with orchestrator-skip entries removed
 */
export async function filterOrchestratorSkippableLogs(logs, outputPath = null) {
  if (!Array.isArray(logs) || logs.length === 0) {
    return [];
  }

  const filtered = logs.filter((log, index) => {
    const shouldSkip = shouldSkipLog(log);
    
    if (shouldSkip) {
      const msg = log?.message || {};
      console.log(`Second-level filter: skipping index ${index}, trace_route: ${msg.trace_route}, log_tag: ${msg.log_tag}`);
    }
    
    return !shouldSkip;
  });

  console.log(`Second-level filtering: ${logs.length} -> ${filtered.length} (removed ${logs.length - filtered.length} orchestrator-skipped entries)`);
  
  // Save final filtered logs to file if outputPath provided
  if (outputPath) {
    try {
      const absolutePath = resolve(process.cwd(), outputPath);
      await writeFile(absolutePath, JSON.stringify(filtered, null, 2), 'utf-8');
      console.log(`Saved final filtered logs to: ${outputPath}`);
    } catch (error) {
      console.error(`Failed to save final filtered logs: ${error.message}`);
    }
  }
  
  return filtered;
}

/**
 * Fetch logs from the JSON API endpoint
 * The JSON file is populated with data from ClickHouse/S3
 */

/**
 * Fetch logs for given order IDs from the logs API
 * @param {string} apiUrl - The API endpoint that returns the logs JSON
 * @param {string[]} orderIds - Array of order IDs to fetch logs for
 * @returns {Promise<Array>} - Array of log entries sorted by messageNumber
 */
export async function fetchLogsFromAPI(apiUrl, orderIds) {
  try {
    const response = await fetch(apiUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({ orderIds })
    });

    if (!response.ok) {
      throw new Error(`HTTP error! status: ${response.status}`);
    }

    const data = await response.json();

    // Validate response structure
    if (!Array.isArray(data)) {
      throw new Error('Invalid response format: expected array of logs');
    }

    // Sort logs by messageNumber to ensure correct sequence
    const sortedLogs = data.sort((a, b) => {
      const numA = a.messageNumber || 0;
      const numB = b.messageNumber || 0;
      return numA - numB;
    });

    console.log(`Fetched ${sortedLogs.length} logs from API`);
    return sortedLogs;

  } catch (error) {
    throw new Error(`Failed to fetch logs: ${error.message}`);
  }
}

/**
 * Alternative: Read logs from a local JSON file in the repo directory
 * Useful for testing with sample data or pre-downloaded logs
 * @param {string} filePath - Relative path from repo root to the JSON file (e.g., 'data/logs.json')
 * @returns {Promise<Array>} - Array of log entries
 */
export async function fetchLogsFromJSONFile(filePath) {
  try {
    // Resolve path relative to repo root (where the script is executed from)
    const absolutePath = resolve(process.cwd(), filePath);

    // Read and parse the JSON file
    const fileContent = await readFile(absolutePath, 'utf-8');
    const data = JSON.parse(fileContent);

    if (!Array.isArray(data)) {
      throw new Error('Invalid JSON format: expected array of logs');
    }

    // Sort logs by messageNumber
    const sortedLogs = data.sort((a, b) => {
      const timeA = a.message?.created_at || '';
      const timeB = b.message?.created_at || '';
      return new Date(timeA) - new Date(timeB);
    });

    console.log(`Loaded ${sortedLogs.length} logs from ${filePath}`);
    return sortedLogs;

  } catch (error) {
    if (error.code === 'ENOENT') {
      throw new Error(`Log file not found: ${filePath}`);
    }
    if (error instanceof SyntaxError) {
      throw new Error(`Invalid JSON in file ${filePath}: ${error.message}`);
    }
    throw new Error(`Failed to load logs from file: ${error.message}`);
  }
}

/**
 * Filter and sort logs by removing duplicates and sorting by created_at
 * Duplicate key: request_id + log_tag + trace_route
 * Keeps first occurrence, removes subsequent duplicates
 * @param {Array} logs - Raw logs array
 * @param {string} outputPath - Optional path to save filtered logs (e.g., 'data/filtered-logs.json')
 * @returns {Array} - Filtered and sorted logs
 */
export async function filterAndSortLogs(logs, outputPath = null) {
  if (!Array.isArray(logs) || logs.length === 0) {
    return [];
  }

  const seen = new Set();
  const duplicates = [];
  const missingPayloadLogs = [];

  const filtered = logs.filter((log, index) => {
    const msg = log?.message || {};

    const hasTraceRequest = msg.trace_request !== undefined && msg.trace_request !== null;
    const hasTraceResponse = msg.trace_response !== undefined && msg.trace_response !== null;
    const hasTraceError = msg.trace_error_msg !== undefined && msg.trace_error_msg !== null;

    if (!hasTraceRequest && !hasTraceResponse && !hasTraceError) {
      missingPayloadLogs.push({
        index,
        requestId: msg.request_id || log?.xRequestId || '',
        logTag: (msg.log_tag || '').trim(),
        traceRoute: msg.trace_route || '',
        checkpoint: msg.checkpoint || 'N/A'
      });
      return false;
    }

    const requestId = msg.request_id || log?.xRequestId || '';
    const logTag = (msg.log_tag || '').trim();
    const traceRoute = msg.trace_route || '';

    const key = `${requestId}_${logTag}_${traceRoute}`;

    if (seen.has(key)) {
      duplicates.push({ index, key: key.substring(0, 60), logTag });
      return false;
    }

    if (logTag.startsWith('CHECKOUT.')) {
      return false;
    }

    seen.add(key);
    return true;
  });

  if (missingPayloadLogs.length > 0) {
    console.log(`Removed ${missingPayloadLogs.length} logs without trace_request/trace_response (checkpoint/metadata logs)`);
    console.log(`Sample logs removed:`, missingPayloadLogs.slice(0, 3));
  }

  // Sort by created_at timestamp
  const sorted = filtered.sort((a, b) => {
    const timeA = a.message?.created_at || '';
    const timeB = b.message?.created_at || '';
    return new Date(timeA) - new Date(timeB);
  });

  console.log(`Filtered logs: ${logs.length} -> ${sorted.length} (removed ${duplicates.length} duplicates)`);
  if (duplicates.length > 0) {
    console.log(`Sample duplicates removed:`, duplicates.slice(0, 3));
  }

  // Save filtered logs to file if outputPath provided
  if (outputPath) {
    try {
      const absolutePath = resolve(process.cwd(), outputPath);
      await writeFile(absolutePath, JSON.stringify(sorted, null, 2), 'utf-8');
      console.log(`Saved filtered logs to: ${outputPath}`);
    } catch (error) {
      console.error(`Failed to save filtered logs: ${error.message}`);
    }
  }

  return sorted;
}

/**
 * Fetch order IDs from ClickHouse via API
 * @param {string} clickhouseApiUrl - API endpoint to fetch order IDs
 * @param {Object} filters - Optional filters (date range, merchant, etc.)
 * @returns {Promise<string[]>} - Array of order IDs
 */
export async function fetchOrderIdsFromClickHouse(clickhouseApiUrl, filters = {}) {
  try {
    const response = await fetch(clickApiUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json'
      },
      body: JSON.stringify(filters)
    });

    if (!response.ok) {
      throw new Error(`HTTP error! status: ${response.status}`);
    }

    const data = await response.json();

    if (!Array.isArray(data)) {
      throw new Error('Invalid response format: expected array of order IDs');
    }

    console.log(`Fetched ${data.length} order IDs from ClickHouse`);
    return data;

  } catch (error) {
    throw new Error(`Failed to fetch order IDs: ${error.message}`);
  }
}
