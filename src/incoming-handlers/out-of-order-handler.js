import { isAsyncParallelApi } from '../config.js';
import { StateManager } from '../services/state-manager.js';

/**
 * OutOfOrderHandler - Handles out-of-order and async/parallel API request processing
 *
 * Handles requests that arrive out of sequence, particularly async/parallel calls
 * that can arrive in any order and need special processing logic.
 */
export class OutOfOrderHandler {
  /**
   * @param {Object} dependencies - Dependencies for the handler
   * @param {Object} dependencies.stateManager - StateManager instance
   * @param {Object} dependencies.validator - LogSequenceValidator instance
   * @param {Object} dependencies.logger - Logger instance
   * @param {Map} dependencies.asyncCallTracker - Map for tracking async calls
   * @param {Object} dependencies.callbacks - Optional callback functions
   */
  constructor({ stateManager, validator, logger, asyncCallTracker, callbacks = {} }) {
    this.stateManager = stateManager;
    this.validator = validator;
    this.logger = logger;
    this.asyncCallTracker = asyncCallTracker;

    // Callbacks for orchestrator methods that can't be directly called
    this.callbacks = {
      comparePayloads: callbacks.comparePayloads || (() => ({ match: true })),
      findCorrespondingResponse: callbacks.findCorrespondingResponse || (() => null),
      forwardToDestination: callbacks.forwardToDestination || (() => Promise.resolve()),
      trackAsyncCompletion: callbacks.trackAsyncCompletion || (() => false),
      getContextKey: callbacks.getContextKey || ((entry) => entry.orderId || `${entry.index}`),
      fail: callbacks.fail || (() => Promise.resolve({ error: 'fail not implemented' })),
      mockExternalRequest: callbacks.mockExternalRequest || (() => Promise.resolve()),
      handleIncomingRequest: callbacks.handleIncomingRequest || (() => Promise.resolve()),
      recordSuccess: callbacks.recordSuccess || (() => {})
    };
  }

  /**
   * Handle an out-of-order request
   * Buffers the request if it's out of sequence, or processes async/parallel calls immediately
   * @param {Object} incoming - The incoming request data
   * @param {Object} validation - Validation context with expectedEntry, foundInLookahead
   * @returns {Promise} Result of handling the request
   */
  async handleOutOfOrderRequest(incoming, validation) {
    this.logger.warn('Handling out-of-order request', {
      expected: validation.expectedEntry?.toString(),
      received: `${incoming.source}→${incoming.destination} ${incoming.logTag}`,
      foundInLookahead: validation.foundInLookahead?.toString()
    });

    const currentEntry = validation.expectedEntry;

    if (validation.foundInLookahead?.isRequest &&
        validation.foundInLookahead.isExternalDestination() &&
        validation.foundInLookahead.source === incoming.source &&
        validation.foundInLookahead.destination === incoming.destination &&
        validation.foundInLookahead.logTag === incoming.logTag) {
      return await this.processFutureExternalCall(incoming, validation.foundInLookahead);
    }

    // Check if current expected is a request we need to trigger ourselves
    if (currentEntry?.isRequest && currentEntry.isExternalDestination()) {
      // For async/parallel calls, process immediately by finding matching log entry
      if (this.isAsyncParallelCall(currentEntry)) {
        return await this.processAsyncParallelCall(incoming, validation.foundInLookahead);
      }

      // GATEWAY→LENDER calls: the Gateway will send this to ART's mock-lender endpoint
      // naturally. ART buffers it and the replay thread's waitForMatchingRequest will
      // match it and respond with the log response. Do NOT mock — just handle the
      // out-of-order incoming request and keep the waiter alive for the LENDER call.
      if (currentEntry.source === 'GATEWAY' && currentEntry.destination === 'LENDER') {
        this.logger.info('Out-of-order while waiting for GATEWAY→LENDER, processing incoming and keeping waiter alive', {
          waitingFor: currentEntry.toString(),
          incoming: `${incoming.source}→${incoming.destination} ${incoming.logTag}`
        });
        // Process the out-of-order incoming request directly
        return this.callbacks.handleIncomingRequest(incoming);
      }

      // For other orchestrator-initiated external calls (APP→LSP etc.), mock immediately
      this.logger.info('Need to mock external request first', {
        entry: currentEntry.toString()
      });

      // Trigger the external request mock
      await this.callbacks.mockExternalRequest(currentEntry);

      // Now retry validation by calling handleIncomingRequest
      return this.callbacks.handleIncomingRequest(incoming);
    }

    const requestKey = StateManager.generateRequestKey(
      incoming.source,
      incoming.api,
      incoming.requestId
    );

    this.stateManager.bufferIncomingRequest(requestKey, incoming);

    return await this.callbacks.fail(`Request out of order. Expected: ${currentEntry?.toString()}`);
  }

  /**
   * Check if this is an async/parallel API call
   * These calls are made in parallel and can arrive in any order
   * @param {Object} entry - Log entry to check
   * @returns {boolean}
   */
  isAsyncParallelCall(entry) {
    return isAsyncParallelApi(entry?.sourceDestination, entry?.logTag);
  }

  /**
   * Process a live external call that arrived before earlier replay entries.
   * This commonly happens with lender polling while ART is still waiting for an
   * async callback in the recorded sequence.
   * @param {Object} incoming - The incoming request
   * @param {Object} expectedEntry - The matching future log entry
   * @returns {Promise} Result of forwarding/mocking the matched entry
   */
  async processFutureExternalCall(incoming, expectedEntry) {
    this.logger.info('Processing future external request from lookahead', {
      incoming: `${incoming.source}→${incoming.destination} ${incoming.logTag}`,
      matchedEntry: expectedEntry.toString()
    });

    const comparison = this.callbacks.comparePayloads(expectedEntry.payload, incoming.payload, incoming.logTag, expectedEntry);
    if (!comparison.match) {
      this.logger.warn('Payload mismatch tolerated for future external request', {
        entry: expectedEntry.toString(),
        logTag: incoming.logTag,
        differences: comparison.differences
      });
    }

    this.validator.markProcessed(expectedEntry);
    this.callbacks.recordSuccess('request_validation', expectedEntry);

    return await this.callbacks.forwardToDestination(incoming, expectedEntry);
  }

  /**
   * Process an async/parallel API call immediately.
   * Finds the matching log entry by lenderOrgId and processes it,
   * regardless of the expected sequence order.
   * @param {Object} incoming - The incoming request
   * @param {Object} matchingEntry - The matching log entry from lookahead
   * @returns {Promise} Result of processing the async parallel call
   */
  async processAsyncParallelCall(incoming, matchingEntry) {
    this.logger.info('Processing async/parallel call immediately', {
      incoming: `${incoming.source}→${incoming.destination} ${incoming.logTag}`,
      lenderOrgId: incoming.lenderOrgId,
      matchedEntry: matchingEntry?.toString()
    });

    if (!matchingEntry) {
      return await this.callbacks.fail(
        `No log entry found for lenderOrgId "${incoming.lenderOrgId}". ` +
        `Expected log for: ${incoming.source}→${incoming.destination} ${incoming.logTag}`
      );
    }

    // Use the matching entry instead of the current expected entry
    const expectedEntry = matchingEntry;

    // Log the API call
    this.logger.logApiCall(incoming.source, incoming.destination, incoming.api, 'REQUEST', expectedEntry.index);

    // Compare payloads
    const expectedPayload = expectedEntry.payload;
    const comparison = this.callbacks.comparePayloads(expectedPayload, incoming.payload, incoming.logTag, expectedEntry);

    if (!comparison.match) {
      this.logger.warn('Payload mismatch tolerated for async/parallel call', {
        entry: expectedEntry.toString(),
        logTag: incoming.logTag,
        differences: comparison.differences
      });
    }

    this.logger.info('Request validation passed', {
      entry: expectedEntry.toString(),
      comparisonMatch: true
    });

    // For async parallel calls processed out of order:
    // 1. Mark matching entry as processed
    // 2. Mock any unprocessed async entries (not just between current and target)
    if (this.isAsyncParallelCall(expectedEntry)) {
      // Find and mock any unprocessed async entries
      // This handles out-of-order arrivals like: SMICC (5), TVS_CREDIT (10), HDB (7)
      for (const entry of this.validator.entries) {
        if (this.validator.processedIndices.has(entry.index)) continue;
        if (!this.isAsyncParallelCall(entry)) continue;
        if (!entry.isRequest) continue;
        if (entry.index === expectedEntry.index) continue; // Will handle below

        this.logger.info('Mocking unprocessed async entry', {
          entry: entry.toString()
        });
        // Mock this entry
        const responseEntry = this.callbacks.findCorrespondingResponse(entry);
        if (responseEntry) {
          this.validator.processedIndices.add(entry.index);
          this.validator.processedIndices.add(responseEntry.index);
          this.callbacks.recordSuccess('request_validation', entry);
          this.callbacks.recordSuccess('response_validation', responseEntry);

          // Track async completion for skipped entries too
          const skippedContextKey = entry.orderId || this.callbacks.getContextKey(entry);
          this.callbacks.trackAsyncCompletion(skippedContextKey, entry);
        }
      }

      // Now mark the actual entry as processed
      this.validator.processedIndices.add(expectedEntry.index);
      this.logger.debug('Marked async parallel entry as processed', {
        entry: expectedEntry.toString(),
        index: expectedEntry.index
      });
    } else {
      this.validator.markProcessed(expectedEntry);
    }
    this.callbacks.recordSuccess('request_validation', expectedEntry);

    // Track async completion for count-based handling
    // For async parallel calls, use orderId as context key to match the tracker
    // initialized from parent LSP->GW request (which doesn't have lenderOrgId)
    const contextKey = expectedEntry.orderId || this.callbacks.getContextKey(expectedEntry);
    const isComplete = this.callbacks.trackAsyncCompletion(contextKey, expectedEntry);
    this.logger.debug('Tracked async parallel call completion', {
      contextKey,
      lenderOrgId: expectedEntry.lenderOrgId,
      isComplete
    });

    // Forward to destination (returns mock response for LENDER)
    return await this.callbacks.forwardToDestination(incoming, expectedEntry);
  }

  /**
   * Find a buffered request that matches the expected async call
   * @param {Object} expectedEntry - The expected log entry
   * @returns {Object|null} The buffered request or null
   */
  findBufferedAsyncCall(expectedEntry) {
    // Use StateManager's method to find by lenderOrgId
    const found = this.stateManager.findBufferedRequestByLenderOrgId(expectedEntry.lenderOrgId);
    if (found &&
        found.data.source === expectedEntry.source &&
        found.data.destination === expectedEntry.destination &&
        found.data.logTag === expectedEntry.logTag) {
      return found;
    }
    return null;
  }

  /**
   * Count pending async/parallel API calls
   * @returns {number} Count of pending async parallel calls
   */
  countPendingAsyncParallelCalls() {
    let count = 0;
    const lookahead = this.validator.peekNext(50);

    for (const entry of lookahead) {
      if (this.isAsyncParallelCall(entry) && !this.validator.processedIndices.has(entry.index)) {
        count++;
      }
    }

    return count;
  }

  /**
   * Process a buffered request through handleIncomingRequest
   * @param {Object} requestData - The request data to process
   * @returns {Promise} Result of processing
   */
  async processBufferedRequest(requestData) {
    return this.callbacks.handleIncomingRequest(requestData);
  }

  /**
   * Process all buffered async/parallel API calls in log sequence order.
   * This handles multiple out-of-order calls that arrived while waiting.
   * @returns {Promise<number>} Number of processed buffered calls
   */
  async processAllBufferedAsyncCalls() {
    // Keep processing as long as there are buffered async calls that match expected entries
    let processed = 0;

    while (true) {
      const currentEntry = this.validator.getCurrentEntry();
      if (!currentEntry || !this.isAsyncParallelCall(currentEntry)) {
        break; // No more async calls expected
      }

      // Look for a buffered call matching the current expected entry
      const buffered = this.findBufferedAsyncCall(currentEntry);
      if (!buffered) {
        break; // No matching buffered call found
      }

      // Remove and process this buffered call
      this.stateManager.removeBufferedRequest(buffered.key);
      this.logger.info('Processing buffered async call', {
        expected: currentEntry.toString(),
        bufferedKey: buffered.key
      });

      await this.processBufferedRequest(buffered.data);
      processed++;
    }

    if (processed > 0) {
      this.logger.info(`Processed ${processed} buffered async call(s)`);
    }

    return processed;
  }

  /**
   * Sleep utility for async waiting
   * @param {number} ms - Milliseconds to sleep
   * @returns {Promise} Resolves after the specified time
   */
  sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
  }
}
