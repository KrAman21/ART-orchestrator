import { logger } from '../utils/logger.js';
import { makeRequest } from '../services/http-client.js';
import { getApiForLogTag as getApiFromConfig } from '../config.js';

/**
 * LogEntry type definition (from log-sequence-validator)
 * @typedef {Object} LogEntry
 * @property {number} index
 * @property {string} sourceDestination
 * @property {string} source
 * @property {string} destination
 * @property {string} logTag
 * @property {boolean} isRequest
 * @property {boolean} isResponse
 * @property {Object} payload
 * @property {string} requestId
 * @property {string} loanApplicationId
 * @property {string} lenderOrgId
 */

/**
 * BaseMockService - Base class for LSP and GW mocks
 *
 * Mocks behave like the real service:
 * 1. Receive request from Orchestrator
 * 2. Look up what the real service would have done (from logs)
 * 3. Make those calls to Orchestrator
 * 4. Return the response from logs
 */
export class BaseMockService {
  constructor(name, config) {
    this.name = name;
    this.port = config.port;
    this.orchestratorUrl = config.orchestratorUrl || 'http://localhost:3001';
    this.logs = [];
    this.parsedLogs = [];
    this.processedIndices = new Set();
    this.server = null;
  }

  /**
   * Load logs for this mock to simulate
   */
  loadLogs(logs) {
    this.logs = logs;
    this.parsedLogs = logs.map((log, index) => this.parseLogEntry(log, index));
    logger.info(`${this.name} mock loaded ${logs.length} logs`);
  }

  /**
   * Parse a log entry (similar to LogSequenceValidator)
   */
  parseLogEntry(rawLog, index) {
    const message = rawLog.message || {};
    const sourceDestination = message.source_destination || '';
    const parts = sourceDestination.split('_');
    const source = parts[0] || '';
    const destination = parts[1] || '';
    const logTag = (message.log_tag || '').trim();
    const isIncoming = message.label === 'APP'? (logTag.endsWith('Request') || logTag.endsWith('INCOMING')) : (logTag.endsWith('Request') || logTag.endsWith('OUTGOING'));
    const isOutgoing = message.label === 'APP'? (logTag.endsWith('Response') || logTag.endsWith('OUTGOING')) : (logTag.endsWith('Response') || logTag.endsWith('INCOMING'));

    return {
      index,
      messageNumber: rawLog.messageNumber,
      rawLog,
      sourceDestination,
      source,
      destination,
      logTag,
      isRequest: isIncoming,
      isResponse: isOutgoing,
      payload: isIncoming
        ? message.trace_request
        : (message.trace_response || message.trace_error_msg),
      requestId: message.request_id || rawLog.xRequestId,
      loanApplicationId: message.loan_application_id,
      lenderOrgId: message.lender_org_id
    };
  }

  /**
   * Find the log entry that matches an incoming request
   */
  findMatchingRequestEntry(api, payload, loanApplicationId) {
    return this.parsedLogs.find((entry, index) => {
      if (this.processedIndices.has(index)) return false;

      // Match by loan_application_id if provided
      if (loanApplicationId && entry.loanApplicationId !== loanApplicationId) {
        return false;
      }

      // Match by destination (this mock's name) and request type
      if (entry.destination !== this.name || !entry.isRequest) {
        return false;
      }

      // Match by API endpoint (derived from logTag)
      const expectedApi = this.getApiForLogTag(entry.logTag);
      if (expectedApi !== api) {
        return false;
      }

      return true;
    });
  }

  /**
   * Find the response entry for a given request
   */
  findResponseForRequest(requestEntry) {
    logger.info(`${this.name} mock finding response for request ${requestEntry.index}`, {
      requestSource: requestEntry.source,
      requestDest: requestEntry.destination,
      requestLogTag: requestEntry.logTag,
      sourceDestination: requestEntry.sourceDestination
    });

    // Debug: log all unprocessed entries
    logger.info(`${this.name} mock unprocessed entries`, {
      entries: this.parsedLogs
        .filter((e, i) => !this.processedIndices.has(i))
        .map(e => ({ idx: e.index, source: e.source, dest: e.destination, logTag: e.logTag, isResponse: e.isResponse }))
    });

    return this.parsedLogs.find((entry, index) => {
      if (this.processedIndices.has(index)) return false;

      // Must be a response from this service
      if (entry.source !== this.name || !entry.isResponse) {
        return false;
      }

      // Direction must be reversed (we're responding)
      if (entry.destination !== requestEntry.source) {
        return false;
      }

      // Match correlation fields
      if (requestEntry.loanApplicationId &&
          entry.loanApplicationId !== requestEntry.loanApplicationId) {
        return false;
      }

      if (requestEntry.lenderOrgId && entry.lenderOrgId !== requestEntry.lenderOrgId) {
        return false;
      }

      logger.info(`${this.name} mock found response at ${index}: ${entry.logTag}`);
      return true;
    });
  }

  /**
   * Find subsequent calls this service makes before responding
   * Returns entries where this service is the source (outgoing calls)
   */
  findSubsequentCalls(requestEntry, responseEntry) {
    const calls = [];
    const startIdx = requestEntry.index;
    const endIdx = responseEntry ? responseEntry.index : this.parsedLogs.length;

    for (let i = startIdx + 1; i < endIdx; i++) {
      const entry = this.parsedLogs[i];
      if (this.processedIndices.has(i)) continue;

      // Check if this is an outgoing call from this service to someone else
      // Note: _OUTGOING tags have isResponse=true but they're calls FROM this service
      if (entry.source === this.name && entry.destination !== requestEntry.source) {
        calls.push(entry);
      }
    }

    return calls;
  }

  /**
   * Find calls this service makes AFTER responding (async behavior)
   * These are fire-and-forget calls made after the response is sent
   * Stops scanning when a new request from APP is encountered (different transaction)
   */
  findAsyncCallsAfterResponse(requestEntry, responseEntry) {
    if (!responseEntry) return [];

    const calls = [];
    const startIdx = responseEntry.index + 1; // Start after response

    logger.info(`${this.name} mock searching for async calls from index ${startIdx}`, {
      responseIdx: responseEntry.index,
      responseDest: responseEntry.destination,
      totalLogs: this.parsedLogs.length
    });

    for (let i = startIdx; i < this.parsedLogs.length; i++) {
      const entry = this.parsedLogs[i];
      if (this.processedIndices.has(i)) continue;

      logger.info(`${this.name} mock checking entry ${i}: ${entry.source}→${entry.destination} ${entry.logTag}`);

      // Stop if we see a new request from external source - that's a different transaction
      if ((entry.source === 'APP' || entry.source === 'LENDER') && entry.isRequest) {
        logger.info(`${this.name} mock stopping async scan - new external request at ${i}`);
        break;
      }

      // Check if this is an outgoing call from this service to someone else
      // Note: _OUTGOING tags have isResponse=true but they're calls FROM this service
      // Exclude responses back to the original requester (already handled by findResponseForRequest)
      if (entry.source === this.name && entry.destination !== requestEntry.source) {
        logger.info(`${this.name} mock found async call at ${i}: ${entry.logTag}`);
        calls.push(entry);
      }
    }

    return calls;
  }

  /**
   * Execute subsequent calls to orchestrator before returning response
   */
  async executeSubsequentCalls(calls) {
    for (const call of calls) {
      logger.info(`${this.name} mock executing subsequent call`, {
        to: call.destination,
        api: this.getApiForLogTag(call.logTag),
        logTag: call.logTag
      });

      // Determine orchestrator endpoint based on who is calling (this mock)
      const orchestratorPath = this.name === 'LSP' ? '/lsp' : '/gw';
      const api = this.getApiForLogTag(call.logTag);

      try {
        await makeRequest(
          this.orchestratorUrl,
          `${orchestratorPath}${api}`,
          'POST',
          call.payload,
          call.requestId,
          call.sourceDestination,
          call.logTag,
          null
        );

        // Mark as processed
        this.processedIndices.add(call.index);

      } catch (error) {
        logger.error(`${this.name} mock failed to execute call`, {
          to: call.destination,
          error: error.message
        });
        throw error;
      }
    }
  }

  /**
   * Handle incoming request from orchestrator
   * This is the main entry point for mock behavior
   */
  async handleRequest(api, payload, requestId, loanApplicationId) {
    logger.info(`${this.name} mock received request`, {
      api,
      requestId,
      loanApplicationId,
      processedIndices: Array.from(this.processedIndices)
    });

    // Find matching request entry in logs
    const requestEntry = this.findMatchingRequestEntry(api, payload, loanApplicationId);

    if (!requestEntry) {
      logger.warn(`${this.name} mock could not find matching request entry`, {
        api,
        loanApplicationId
      });
      return {
        status: 404,
        error: 'No matching request found in logs'
      };
    }

    logger.info(`${this.name} mock matched request entry`, {
      index: requestEntry.index,
      logTag: requestEntry.logTag
    });

    // Find expected response
    const responseEntry = this.findResponseForRequest(requestEntry);

    // Find synchronous calls (between request and response)
    const syncCalls = this.findSubsequentCalls(requestEntry, responseEntry);

    // Find async calls (after response - only for responses to external sources)
    let asyncCalls = [];
    if (responseEntry && ['APP', 'LENDER'].includes(responseEntry.destination)) {
      asyncCalls = this.findAsyncCallsAfterResponse(requestEntry, responseEntry);
    }

    // If this mock is responding to an internal service (not external),
    // all calls to external destinations are async (fire-and-forget)
    let callsToDefer = [];
    if (responseEntry && !['APP', 'LENDER'].includes(requestEntry.source)) {
      // Internal request (e.g., LSP->GW): defer all external calls
      callsToDefer = syncCalls.filter(c => ['APP', 'LENDER'].includes(c.destination));
      // Remove deferred calls from sync calls
      syncCalls.splice(0, syncCalls.length, ...syncCalls.filter(c => !['APP', 'LENDER'].includes(c.destination)));
      asyncCalls.unshift(...callsToDefer);
    }

    logger.info(`${this.name} mock will execute ${syncCalls.length} sync + ${asyncCalls.length} async calls`, {
      hasResponse: !!responseEntry
    });

    // Execute sync calls before returning response
    if (syncCalls.length > 0) {
      await this.executeSubsequentCalls(syncCalls);
    }

    // Mark request as processed
    this.processedIndices.add(requestEntry.index);

    // Return response if found
    if (responseEntry) {
      logger.info(`${this.name} mock returning response`, {
        logTag: responseEntry.logTag,
        responseIndex: responseEntry.index,
        responsePayload: JSON.stringify(responseEntry.payload).substring(0, 200)
      });

      // Execute async calls sequentially after returning response
      // Wait for orchestrator to process each one (including mock responses)
      if (asyncCalls.length > 0) {
        // Use setImmediate to ensure response is sent first, then execute async calls
        setImmediate(async () => {
          try {
            for (const call of asyncCalls) {
              await this.executeSubsequentCalls([call]);
              // Small delay to let orchestrator process
              await new Promise(r => setTimeout(r, 10));
            }
          } catch (error) {
            logger.error(`${this.name} mock async calls failed`, { error: error.message });
          }
        });
      }

      this.processedIndices.add(responseEntry.index);
      return {
        status: 200,
        data: responseEntry.payload
      };
    }

    // No response expected (fire-and-forget)
    return {
      status: 200,
      data: { success: true }
    };
  }

  /**
   * Map log tag to API endpoint
   * Uses config.js
   */
  getApiForLogTag(logTag) {
    return getApiFromConfig(logTag) || '/api/unknown';
  }

  /**
   * Get mock status
   */
  getStatus() {
    return {
      name: this.name,
      port: this.port,
      totalLogs: this.logs.length,
      processedEntries: this.processedIndices.size,
      remainingEntries: this.logs.length - this.processedIndices.size
    };
  }
}

export default BaseMockService;
