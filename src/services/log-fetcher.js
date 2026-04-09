import { readFile } from 'fs/promises';
import { resolve } from 'path';

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
 * Fetch order IDs from ClickHouse via API
 * @param {string} clickhouseApiUrl - API endpoint to fetch order IDs
 * @param {Object} filters - Optional filters (date range, merchant, etc.)
 * @returns {Promise<string[]>} - Array of order IDs
 */
export async function fetchOrderIdsFromClickHouse(clickhouseApiUrl, filters = {}) {
  try {
    const response = await fetch(clickhouseApiUrl, {
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
