import { readFile, writeFile } from 'fs/promises';
import { resolve } from 'path';

function getCreatedAtTime(log) {
  const createdAt = log?.message?.created_at;
  const timestamp = createdAt ? new Date(createdAt).getTime() : Number.NaN;
  return Number.isNaN(timestamp) ? Number.POSITIVE_INFINITY : timestamp;
}

function getLogDirectionPriority(log) {
  const logTag = (log?.message?.log_tag || '').trim().toUpperCase();

  if (logTag.endsWith('_REQUEST') || logTag.endsWith('REQUEST')) {
    return 0;
  }

  if (logTag.endsWith('_RESPONSE') || logTag.endsWith('RESPONSE')) {
    return 1;
  }

  return 2;
}

function getMessageNumber(log) {
  const messageNumber = Number(log?.messageNumber);
  return Number.isFinite(messageNumber) ? messageNumber : Number.POSITIVE_INFINITY;
}

export function compareLogsForReplay(left, right) {
  const createdAtDiff = getCreatedAtTime(left) - getCreatedAtTime(right);
  if (createdAtDiff !== 0) {
    return createdAtDiff;
  }

  const directionDiff = getLogDirectionPriority(left) - getLogDirectionPriority(right);
  if (directionDiff !== 0) {
    return directionDiff;
  }

  const messageNumberDiff = getMessageNumber(left) - getMessageNumber(right);
  if (messageNumberDiff !== 0) {
    return messageNumberDiff;
  }

  const leftTag = (left?.message?.log_tag || '').trim();
  const rightTag = (right?.message?.log_tag || '').trim();
  const tagDiff = leftTag.localeCompare(rightTag);
  if (tagDiff !== 0) {
    return tagDiff;
  }

  const leftRoute = left?.message?.trace_route || '';
  const rightRoute = right?.message?.trace_route || '';
  return leftRoute.localeCompare(rightRoute);
}

function getPairingGroupKey(tagInfo, traceRoute) {
  // Some Themis flows log requests and responses on different trace routes,
  // but they are still one logical replay pair.
  if (tagInfo.baseTag === 'Themis-Eligibility' || tagInfo.baseTag === 'Themis-KFS') {
    return tagInfo.baseTag;
  }

  return `${tagInfo.baseTag}__${traceRoute}`;
}

function getRequestResponseTagInfo(logTag) {
  const normalizedTag = (logTag || '').trim();

  if (!normalizedTag) {
    return null;
  }

  if (/_REQUEST$/i.test(normalizedTag)) {
    return {
      kind: 'request',
      baseTag: normalizedTag.replace(/_REQUEST$/i, '')
    };
  }

  if (/REQUEST$/i.test(normalizedTag)) {
    return {
      kind: 'request',
      baseTag: normalizedTag.replace(/REQUEST$/i, '')
    };
  }

  if (/_RESPONSE$/i.test(normalizedTag)) {
    return {
      kind: 'response',
      baseTag: normalizedTag.replace(/_RESPONSE$/i, '')
    };
  }

  if (/RESPONSE$/i.test(normalizedTag)) {
    return {
      kind: 'response',
      baseTag: normalizedTag.replace(/RESPONSE$/i, '')
    };
  }

  return null;
}

const HARD_ELIGIBILITY_DEPENDENT_TAGS = new Set([
  'LSP-FetchOfferRequest_REQUEST',
  'LSP-FetchOfferRequest_RESPONSE',
  'POLLING API :: LINE_STATUS_REQUEST',
  'POLLING API :: LINE_STATUS_RESPONSE',
  'FETCH_OFFER_ASYNC_RESPONSE_REQUEST',
  'FETCH_OFFER_ASYNC_RESPONSE_RESPONSE',
  'LSP-HardEligibility_REQUEST',
  'LSP-HardEligibility_RESPONSE',
  'Themis-HardEligibility_REQUEST',
  'Themis-HardEligibility_RESPONSE',
  'FlipKart-HardEligibilityStatus_REQUEST',
  'FlipKart-HardEligibilityStatus_RESPONSE',
  'FlipKart-GetRedirectionURL_REQUEST',
  'FlipKart-GetRedirectionURL_RESPONSE',
  'ProcessStatus_REQUEST',
  'ProcessStatus_RESPONSE'
]);

const SELECT_OFFER_DEPENDENT_TAGS = new Set([
  'LOCK_TENURE_REQUEST',
  'LOCK_TENURE_RESPONSE',
  'GET_REDIRECTION_URL_SO_REQUEST',
  'GET_REDIRECTION_URL_SO_RESPONSE',
  'LSP-LoanStatus_REQUEST',
  'LSP-LoanStatus_RESPONSE',
  'Lsp-LoanStatusRequest_REQUEST',
  'Lsp-LoanStatusRequest_RESPONSE'
]);

function pruneDependentsAfterRemovedTrigger(logs, keepSet, {
  triggerTag,
  triggerRoute,
  dependentTags,
  reason
}) {
  const removedTriggerTimes = logs
    .map((log, index) => ({ log, index }))
    .filter(({ log, index }) => {
      const msg = log?.message || {};
      return !keepSet.has(index) && msg.trace_route === triggerRoute && msg.log_tag === triggerTag;
    })
    .map(({ log }) => getCreatedAtTime(log))
    .filter(timestamp => Number.isFinite(timestamp));

  if (removedTriggerTimes.length === 0) {
    return logs.filter((_, index) => keepSet.has(index));
  }

  const firstRemovedTriggerAt = Math.min(...removedTriggerTimes);

  return logs.filter((log, index) => {
    if (!keepSet.has(index)) {
      return false;
    }

    const msg = log?.message || {};
    const createdAt = getCreatedAtTime(log);
    const shouldPrune =
      createdAt >= firstRemovedTriggerAt &&
      dependentTags.has((msg.log_tag || '').trim());

    if (shouldPrune) {
      console.log(`Pruned orphaned ${reason} dependent log: index ${index}, trace_route: ${msg.trace_route}, log_tag: ${msg.log_tag}`);
    }

    return !shouldPrune;
  });
}

function pruneOrphanedHardEligibilityDependents(logs, keepSet) {
  return pruneDependentsAfterRemovedTrigger(logs, keepSet, {
    triggerTag: 'FlipKart-HardEligibility_REQUEST',
    triggerRoute: 'APP_WRAPPER',
    dependentTags: HARD_ELIGIBILITY_DEPENDENT_TAGS,
    reason: 'hard-eligibility'
  });
}

function pruneOrphanedSelectOfferDependents(logs, keepSet) {
  return pruneDependentsAfterRemovedTrigger(logs, keepSet, {
    triggerTag: 'LSP-SelectOffer_REQUEST',
    triggerRoute: 'CORE_GATEWAY',
    dependentTags: SELECT_OFFER_DEPENDENT_TAGS,
    reason: 'select-offer'
  });
}

function balanceRequestResponsePairs(logs) {
  const groups = new Map();
  const keepSet = new Set();
  const stats = new Map();

  logs.forEach((log, index) => {
    const msg = log?.message || {};
    const logTag = (msg.log_tag || '').trim();
    const traceRoute = msg.trace_route || '';
    const tagInfo = getRequestResponseTagInfo(logTag);

    if (!tagInfo) {
      keepSet.add(index);
      return;
    }

    const groupKey = getPairingGroupKey(tagInfo, traceRoute);
    const group = groups.get(groupKey) || {
      baseTag: tagInfo.baseTag,
      traceRoute,
      pendingRequests: []
    };

    const groupStats = stats.get(groupKey) || {
      baseTag: tagInfo.baseTag,
      traceRoute,
      requestsSeen: 0,
      responsesSeen: 0,
      pairsKept: 0
    };

    if (tagInfo.kind === 'request') {
      group.pendingRequests.push(index);
      groupStats.requestsSeen += 1;
    } else if (group.pendingRequests.length > 0) {
      const requestIndex = group.pendingRequests.shift();
      keepSet.add(requestIndex);
      keepSet.add(index);
      groupStats.responsesSeen += 1;
      groupStats.pairsKept += 1;
    } else {
      groupStats.responsesSeen += 1;
    }

    groups.set(groupKey, group);
    stats.set(groupKey, groupStats);
  });

  for (const groupStats of stats.values()) {
    if (groupStats.requestsSeen !== groupStats.responsesSeen) {
      console.log(
        `Balanced ${groupStats.baseTag} on [${groupStats.traceRoute}]: kept ${groupStats.pairsKept} pair(s), removed ${groupStats.requestsSeen - groupStats.pairsKept} request(s) and ${groupStats.responsesSeen - groupStats.pairsKept} response(s)`
      );
    }
  }

  const hardEligibilityPruned = pruneOrphanedHardEligibilityDependents(logs, keepSet);
  const keptAfterHardEligibilityPrune = new Set(hardEligibilityPruned.map(log => logs.indexOf(log)));
  return pruneOrphanedSelectOfferDependents(logs, keptAfterHardEligibilityPrune);
}

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

  // Async fetch-offer completion is already represented by
  // FETCH_OFFER_ASYNC_RESPONSE_RESPONSE in the replay flow.
  if (logTag === 'LSP-FetchOfferResponse_RESPONSE') {
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

  const balanced = balanceRequestResponsePairs(filtered);
  
  // Save final filtered logs to file if outputPath provided
  if (outputPath) {
    try {
      const absolutePath = resolve(process.cwd(), outputPath);
      await writeFile(absolutePath, JSON.stringify(balanced, null, 2), 'utf-8');
      console.log(`Saved final filtered logs to: ${outputPath}`);
    } catch (error) {
      console.error(`Failed to save final filtered logs: ${error.message}`);
    }
  }
  
  return balanced;
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
    const sortedLogs = data.sort(compareLogsForReplay);

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

  const sortedByTime = [...logs].sort(compareLogsForReplay);
  const seen = new Set();
  const duplicates = [];
  const missingPayloadLogs = [];

  const filtered = sortedByTime.filter((log, index) => {
    const msg = log?.message || {};
    const logTag = (msg.log_tag || '').trim();
    const traceRoute = msg.trace_route || '';

    const hasTraceRequest = msg.trace_request !== undefined && msg.trace_request !== null;
    const hasTraceResponse = msg.trace_response !== undefined && msg.trace_response !== null;
    const hasTraceError = msg.trace_error_msg !== undefined && msg.trace_error_msg !== null;
    const hasTraceRequestAck = msg.trace_request_ack !== undefined && msg.trace_request_ack !== null;
    const hasTraceResponseAck = msg.trace_response_ack !== undefined && msg.trace_response_ack !== null;

    if (!hasTraceRequest && !hasTraceResponse && !hasTraceError && !hasTraceRequestAck && !hasTraceResponseAck) {
      if (logTag.includes('HardEligibility')) {
        console.log(`First-level filter: dropping hard eligibility log without payload/ack at sorted index ${index}, trace_route: ${traceRoute}, log_tag: ${logTag}, request_id: ${msg.request_id || log?.xRequestId || ''}`);
      }

      missingPayloadLogs.push({
        index,
        requestId: msg.request_id || log?.xRequestId || '',
        logTag,
        traceRoute,
        checkpoint: msg.checkpoint || 'N/A'
      });
      return false;
    }

    const requestId = msg.request_id || log?.xRequestId || '';

    const key = `${requestId}_${logTag}_${traceRoute}`;

    if (seen.has(key)) {
      if (logTag.includes('HardEligibility')) {
        console.log(`First-level filter: dropping duplicate hard eligibility log at sorted index ${index}, key: ${key}`);
      }

      duplicates.push({ index, key: key.substring(0, 60), logTag });
      return false;
    }

    if (logTag.startsWith('CHECKOUT.')) {
      if (logTag.includes('HardEligibility')) {
        console.log(`First-level filter: dropping checkout hard eligibility log at sorted index ${index}, log_tag: ${logTag}`);
      }

      return false;
    }

    seen.add(key);
    return true;
  });

  if (missingPayloadLogs.length > 0) {
    console.log(`Removed ${missingPayloadLogs.length} logs without trace_request/trace_response/ack payloads (checkpoint/metadata logs)`);
    console.log(`Sample logs removed:`, missingPayloadLogs.slice(0, 3));
  }

  const sorted = filtered;

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
