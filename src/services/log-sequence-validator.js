import { logger } from '../utils/logger.js';
import { isAsyncParallelApi } from '../config.js';

/**
 * LogEntry represents a parsed log entry from the trace
 */
class LogEntry {
  constructor(rawLog, index) {
    this.index = index;
    this.rawLog = rawLog;
    this.messageNumber = rawLog.messageNumber;
    this.message = rawLog.message || {};
    this.xRequestId = rawLog.xRequestId;

    // Parse source_destination with WRAPPER remapping
    // Format: SOURCE_DEST (e.g., APP_LSP, LSP_GW)
    // APP_WRAPPER -> APP_LSP, WRAPPER_APP -> LSP_APP
    const rawSourceDestination = this.message.source_destination || '';
    this.originalSourceDestination = rawSourceDestination; // Keep original for config lookups
    this.sourceDestination = this.remapWrapperSourceDestination(rawSourceDestination);
    const parts = this.sourceDestination.split('_');

    // Log tag and type - determines if this is a request or response
    this.logTag = (this.message.log_tag || '').trim();
    const isIncoming = this.message.label === 'APP'? (this.logTag.endsWith('Request') || this.logTag.endsWith('INCOMING')) : (this.logTag.endsWith('Request') || this.logTag.endsWith('OUTGOING'));
    const isOutgoing = this.message.label === 'APP'? (this.logTag.endsWith('Response') || this.logTag.endsWith('OUTGOING')) : (this.logTag.endsWith('Response') || this.logTag.endsWith('INCOMING'));
    this.isRequest = isIncoming;
    this.isResponse = isOutgoing;

    // Parse source/destination - swap for responses since source_destination in logs
    // always shows the request direction (e.g., APP_WRAPPER for both request and response)
    if (this.isResponse) {
      // For responses, swap source and destination (but keep sourceDestination unchanged for lookups)
      this.source = parts[1] || '';
      this.destination = parts[0] || '';
    } else {
      this.source = parts[0] || '';
      this.destination = parts[1] || '';
    }

    // Extract payload based on type
    this.payload = this.isRequest
      ? this.message.trace_request
      : (this.message.trace_response || this.message.trace_error_msg);

    // Correlation info
    this.requestId = this.message.request_id || this.xRequestId;
    this.loanApplicationId = this.message.loan_application_id;
    this.lenderOrgId = this.message.lender_org_id;
    this.orderId = this.message.order_id;
  }

  /**
   * Generate a matching key for this log entry
   */
  getMatchingKey() {
    // For requests: source + destination + api type
    // For responses: destination + source + api type (reversed direction)
    if (this.isRequest) {
      return `REQ:${this.sourceDestination}:${this.logTag}`;
    } else {
      return `RES:${this.sourceDestination}:${this.logTag}`;
    }
  }

  /**
   * Remap WRAPPER source_destination to actual service equivalents
   * - APP_WRAPPER -> APP_LSP
   * - WRAPPER_APP -> LSP_APP
   * Others remain unchanged
   */
  remapWrapperSourceDestination(sourceDestination) {
    const remappings = {
      'APP_WRAPPER': 'APP_LSP',
      'WRAPPER_APP': 'LSP_APP'
    };
    return remappings[sourceDestination] || sourceDestination;
  }

  /**
   * Check if this log entry should be skipped
   * Skip if source or destination is WRAPPER (except remapped cases)
   */
  shouldSkip() {
    // Original source_destination before remapping
    const original = this.message.source_destination || '';
    const originalParts = original.split('_');
    const originalSource = originalParts[0] || '';
    const originalDest = originalParts[1] || '';

    // Skip if WRAPPER is involved (and wasn't remapped)
    if (originalSource === 'WRAPPER' || originalDest === 'WRAPPER') {
      // Check if it was remapped (remapped values don't have WRAPPER)
      return !original.startsWith('APP_WRAPPER') && !original.startsWith('WRAPPER_APP');
    }

    return false;
  }

  /**
   * Check if destination is external (APP, LENDER)
   */
  isExternalDestination() {
    return ['APP', 'LENDER'].includes(this.destination);
  }

  /**
   * Check if source is external (APP, LENDER)
   */
  isExternalSource() {
    return ['APP', 'LENDER'].includes(this.source);
  }

  /**
   * Check if this log entry is a webhook
   * Webhooks have "Webhook" in their logTag, or are APP->GW/LENDER->GW requests
   * that are not the main API flow (like FlipKart-EligibilityStatus)
   */
  isWebhook() {
    if (this.logTag?.includes('Webhook')) return true;

    // APP->GW or LENDER->GW requests that are callbacks/notifications
    if ((this.source === 'APP' || this.source === 'LENDER') && this.destination === 'GW') {
      // Exclude main request-response pairs (these would be tracked normally)
      // Webhooks typically have status/update/callback in their name
      const webhookIndicators = ['Status', 'Callback', 'Notification', 'Update', 'Event', 'Webhook'];
      return webhookIndicators.some(indicator =>
        this.logTag?.toLowerCase().includes(indicator.toLowerCase())
      );
    }

    return false;
  }

  /**
   * Check if this log entry is a LENDER->GW webhook
   */
  isLenderToGwWebhook() {
    return this.isWebhook() && this.source === 'LENDER' && this.destination === 'GW';
  }

  toString() {
    return `[${this.index}] ${this.logTag} ${this.source}→${this.destination}`;
  }
}

/**
 * LogSequenceValidator validates that replay events match the expected log sequence
 */
export class LogSequenceValidator {
  constructor(logs = []) {
    this.rawLogs = logs;
    this.entries = [];
    this.currentIndex = 0;
    this.processedIndices = new Set();

    this.parseLogs();
  }

  /**
   * Parse raw logs into LogEntry objects
   */
  parseLogs() {
    this.entries = this.rawLogs.map((log, index) => new LogEntry(log, index));
    logger.info('Parsed log entries', { count: this.entries.length });
  }

  /**
   * Get the current log entry we're expecting to process next
   */
  getCurrentEntry() {
    // Skip entries that should be skipped or are already processed
    while (
      this.currentIndex < this.entries.length &&
      (this.entries[this.currentIndex].shouldSkip() ||
       this.processedIndices.has(this.currentIndex))
    ) {
      if (this.entries[this.currentIndex].shouldSkip()) {
        logger.debug('Skipping WRAPPER entry', {
          index: this.currentIndex,
          entry: this.entries[this.currentIndex].toString()
        });
      } else {
        logger.debug('Skipping already processed entry', {
          index: this.currentIndex,
          entry: this.entries[this.currentIndex].toString()
        });
      }
      this.processedIndices.add(this.currentIndex);
      this.currentIndex++;
    }

    if (this.currentIndex >= this.entries.length) {
      return null;
    }

    return this.entries[this.currentIndex];
  }

  /**
   * Peek at the next N entries without advancing
   */
  peekNext(count = 3) {
    const result = [];
    let peekIndex = this.currentIndex;

    while (result.length < count && peekIndex < this.entries.length) {
      const entry = this.entries[peekIndex];
      if (!entry.shouldSkip()) {
        result.push(entry);
      }
      peekIndex++;
    }

    return result;
  }

  /**
   * Find a specific log entry by criteria
   * @param {Object} criteria - { source, destination, logTag, requestId }
   */
  findEntry(criteria) {
    return this.entries.find((entry, index) => {
      if (this.processedIndices.has(index)) return false;

      let match = true;
      if (criteria.source && entry.source !== criteria.source) match = false;
      if (criteria.destination && entry.destination !== criteria.destination) match = false;
      if (criteria.logTag && entry.logTag !== criteria.logTag) match = false;
      if (criteria.requestId && entry.requestId !== criteria.requestId) match = false;
      if (criteria.isRequest !== undefined && entry.isRequest !== criteria.isRequest) match = false;

      return match;
    });
  }

  /**
   * Validate an incoming request against expected log sequence
   * @param {Object} incoming - { source, destination, logTag, payload, requestId }
   * @returns {Object} - { valid: boolean, expectedEntry: LogEntry, error?: string }
   */
  validateIncomingRequest(incoming) {
    const currentEntry = this.getCurrentEntry();
    // console.log('Validating incoming request', {
    //   incoming,
    //   currentEntry: currentEntry ? currentEntry.toString() : 'none'
    // });

    if (!currentEntry) {
      return {
        valid: false,
        expectedEntry: null,
        error: 'No more entries to process - unexpected request received'
      };
    }

    // Strict lender validation: Check if incoming lenderOrgId has a matching log entry
    if (incoming.lenderOrgId) {
      const hasMatchingLenderLog = this.entries.some(entry =>
        !this.processedIndices.has(entry.index) &&
        entry.lenderOrgId === incoming.lenderOrgId &&
        entry.source === incoming.source &&
        entry.destination === incoming.destination &&
        entry.logTag === incoming.logTag
      );

      // Also check if this lender was already processed (retry scenario)
      const wasAlreadyProcessed = this.entries.some(entry =>
        this.processedIndices.has(entry.index) &&
        entry.lenderOrgId === incoming.lenderOrgId &&
        entry.source === incoming.source &&
        entry.destination === incoming.destination &&
        entry.logTag === incoming.logTag
      );

      if (!hasMatchingLenderLog && !wasAlreadyProcessed) {
        return {
          valid: false,
          expectedEntry: currentEntry,
          error: `No log entry found for lenderOrgId "${incoming.lenderOrgId}". Expected log for: ${incoming.source}→${incoming.destination} ${incoming.logTag}`,
          alreadyProcessed: wasAlreadyProcessed
        };
      }

      // If already processed, this is a retry - let handleRetryRequest deal with it
      if (wasAlreadyProcessed) {
        logger.debug('Lender already processed, likely a retry', {
          lenderOrgId: incoming.lenderOrgId,
          source: incoming.source,
          destination: incoming.destination
        });
      }
    }

    // Check if this matches what we expect
    const expectedType = currentEntry.isRequest ? 'REQUEST' : 'RESPONSE';
    const incomingType = incoming.isRequest ? 'REQUEST' : 'RESPONSE';

    if (currentEntry.isRequest) {
      // We're expecting a request - validate match
      const matches = this.matchesExpected(currentEntry, incoming);

      if (matches) {
        logger.info('Request matches expected log entry', {
          entry: currentEntry.toString(),
          requestId: incoming.requestId
        });
        return { valid: true, expectedEntry: currentEntry };
      }

      // Check if there's a webhook or out-of-order event we should process first
      const lookahead = this.peekNext(10);
      const foundInLookahead = lookahead.find(entry =>
        entry.isRequest &&
        entry.source === incoming.source &&
        entry.destination === incoming.destination &&
        entry.logTag === incoming.logTag &&
        this.matchesExpected(entry, incoming)
      );

      // For async/parallel calls, don't match in lookahead if current expected is also async
      // with a different lenderOrgId - we should wait for the expected call
      const isAsyncParallel = this.isAsyncParallelCall(incoming);
      if (foundInLookahead && isAsyncParallel) {
        const isCurrentAsync = this.isAsyncParallelCall(currentEntry);
        if (isCurrentAsync && currentEntry.lenderOrgId !== incoming.lenderOrgId) {
          // Current expected is a different async call - don't match the lookahead
          logger.warn('Async call found in lookahead but waiting for current expected', {
            current: currentEntry.toString(),
            currentLender: currentEntry.lenderOrgId,
            receivedLender: incoming.lenderOrgId
          });
          // Fall through to async handling below
        } else {
          // Current expected is not async or same lender - use lookahead match
          logger.warn('Request found in lookahead but not at current position', {
            current: currentEntry.toString(),
            found: foundInLookahead.toString()
          });
          return {
            valid: false,
            expectedEntry: currentEntry,
            foundInLookahead: foundInLookahead,
            error: `Expected ${currentEntry.toString()} but received ${incoming.source}→${incoming.destination} ${incoming.logTag}`
          };
        }
      } else if (foundInLookahead) {
        logger.warn('Request found in lookahead but not at current position', {
          current: currentEntry.toString(),
          found: foundInLookahead.toString()
        });
        return {
          valid: false,
          expectedEntry: currentEntry,
          foundInLookahead: foundInLookahead,
          error: `Expected ${currentEntry.toString()} but received ${incoming.source}→${incoming.destination} ${incoming.logTag}`
        };
      }

      // Check if this is an async/parallel API call that can arrive out of order
      if (isAsyncParallel) {
        const foundAsyncCall = lookahead.find(entry =>
          !this.processedIndices.has(entry.index) &&
          entry.isRequest &&
          isAsyncParallelApi(entry.sourceDestination, entry.logTag) &&
          entry.lenderOrgId === incoming.lenderOrgId
        );

        if (foundAsyncCall) {
          logger.warn('Async/parallel call received out of order', {
            current: currentEntry.toString(),
            received: `${incoming.source}→${incoming.destination} ${incoming.logTag}`,
            lenderOrgId: incoming.lenderOrgId,
            expectedLenderOrgId: currentEntry.lenderOrgId
          });
          return {
            valid: false,
            expectedEntry: currentEntry,
            foundInLookahead: foundAsyncCall,
            isAsyncParallelCall: true,
            error: `Expected ${currentEntry.toString()} but received async call from ${incoming.lenderOrgId}`
          };
        }
      }

      return {
        valid: false,
        expectedEntry: currentEntry,
        error: `Request mismatch. Expected: ${currentEntry.toString()}, Got: ${incoming.source}→${incoming.destination} ${incoming.logTag}`
      };
    }

    // We're expecting a response, but got a request
    // This might be okay if the response came early and was buffered
    return {
      valid: false,
      expectedEntry: currentEntry,
      isEarly: true,
      error: `Expected response ${currentEntry.toString()} but received request`
    };
  }

  /**
   * Check if incoming request matches expected log entry
   */
  matchesExpected(expected, incoming) {
    // Basic matching on source, destination, and log tag
    if (
      expected.source !== incoming.source ||
      expected.destination !== incoming.destination ||
      expected.logTag !== incoming.logTag
    ) {
      return false;
    }

    // For async/parallel API calls, lenderOrgId is the PRIMARY identifier
    // because the source service reuses the same requestId for all parallel calls
    const isAsyncParallel = isAsyncParallelApi(
      expected.sourceDestination,
      expected.logTag
    );

    if (isAsyncParallel && expected.lenderOrgId && incoming.lenderOrgId) {
      // For async parallel calls, lenderOrgId MUST match
      return expected.lenderOrgId === incoming.lenderOrgId;
    }

    // Compare loanApplicationId if present in expected entry
    if (expected.loanApplicationId && incoming.loanApplicationId) {
      if (expected.loanApplicationId !== incoming.loanApplicationId) {
        return false;
      }
    }

    // Compare lenderOrgId if present in expected entry (for non-async calls)
    if (expected.lenderOrgId && incoming.lenderOrgId) {
      if (expected.lenderOrgId !== incoming.lenderOrgId) {
        return false;
      }
    }

    // Compare requestId if present in both
    // Note: Some services (like Gateway) propagate parent request IDs, causing mismatches.
    // We log the mismatch but don't fail validation if source/destination/logTag match.
    if (expected.requestId && incoming.requestId) {
      if (expected.requestId !== incoming.requestId) {
        logger.debug('RequestId mismatch (allowed)', {
          expected: expected.requestId,
          incoming: incoming.requestId,
          entry: expected.toString?.() || expected.logTag
        });
        // Don't fail - requestId propagation varies by service
      }
    }

    return true;
  }

  /**
   * Check if this is an async/parallel API call
   * These calls are made in parallel and can arrive in any order
   */
  isAsyncParallelCall(entry) {
    return isAsyncParallelApi(entry?.sourceDestination, entry?.logTag);
  }

  /**
   * Count async calls expected between the current position and the next parent response.
   * This is used for count-based completion of async API calls.
   * @param {number} startIndex - Index to start counting from (typically currentIndex)
   * @param {string} parentContextKey - Context key of the parent request to match
   * @returns {Object} - { count: number, entries: LogEntry[], parentResponseIndex: number|null }
   */
  countExpectedAsyncCalls(startIndex = this.currentIndex, parentContextKey = null) {
    const asyncEntries = [];
    let parentResponseIndex = null;

    // Find all unprocessed async calls until we hit the parent response
    for (let i = startIndex; i < this.entries.length; i++) {
      const entry = this.entries[i];

      // Skip already processed entries
      if (this.processedIndices.has(i)) continue;

      // Skip entries that should be skipped
      if (entry.shouldSkip()) continue;

      // Check if this is the parent response (GW->LSP response)
      if (entry.isResponse && entry.source === 'GW' && entry.destination === 'LSP') {
        // Check if it matches the parent context
        const entryContextKey = this.getContextKeyForMatching(entry);
        if (!parentContextKey || entryContextKey === parentContextKey || this.contextsMatchByKey(parentContextKey, entryContextKey)) {
          parentResponseIndex = i;
          break;
        }
      }

      // Check if this is an async call
      if (entry.isRequest && this.isAsyncParallelCall(entry)) {
        // Only count if it matches the parent context (same loan/order)
        const entryContextKey = this.getContextKeyForMatching(entry);
        if (!parentContextKey || entryContextKey === parentContextKey || this.contextsMatchByKey(parentContextKey, entryContextKey)) {
          asyncEntries.push(entry);
        }
      }
    }

    return {
      count: asyncEntries.length,
      entries: asyncEntries,
      parentResponseIndex
    };
  }

  /**
   * Find the parent response entry for a given request entry.
   * Looks ahead to find the matching GW->LSP or APP<-GW response.
   * @param {LogEntry} requestEntry - The request entry to find response for
   * @returns {LogEntry|null} - The parent response entry or null
   */
  findParentResponse(requestEntry) {
    const requestContextKey = this.getContextKeyForMatching(requestEntry);

    for (let i = requestEntry.index + 1; i < this.entries.length; i++) {
      const entry = this.entries[i];

      if (this.processedIndices.has(i)) continue;
      if (entry.shouldSkip()) continue;

      // Look for GW->LSP response or GW->APP response
      if (entry.isResponse &&
          ((entry.source === 'GW' && entry.destination === 'LSP') ||
           (entry.source === 'GW' && entry.destination === 'APP'))) {
        const entryContextKey = this.getContextKeyForMatching(entry);
        if (entryContextKey === requestContextKey || this.contextsMatchByKey(requestContextKey, entryContextKey)) {
          return entry;
        }
      }
    }

    return null;
  }

  /**
   * Check if two context keys match (partial match is allowed)
   */
  contextsMatchByKey(keyA, keyB) {
    if (!keyA || !keyB) return false;
    // Split by ':' and check if any part matches
    const partsA = keyA.split(':');
    const partsB = keyB.split(':');
    return partsA.some(part => partsB.includes(part));
  }

  /**
   * Find an unprocessed log entry by exact criteria including lenderOrgId
   * @param {Object} criteria - { source, destination, logTag, lenderOrgId }
   * @returns {LogEntry|null}
   */
  findUnprocessedEntryByLenderOrgId(criteria) {
    return this.entries.find((entry, index) => {
      if (this.processedIndices.has(index)) return false;
      if (entry.shouldSkip()) return false;

      if (criteria.source && entry.source !== criteria.source) return false;
      if (criteria.destination && entry.destination !== criteria.destination) return false;
      if (criteria.logTag && entry.logTag !== criteria.logTag) return false;
      if (criteria.lenderOrgId && entry.lenderOrgId !== criteria.lenderOrgId) return false;

      return true;
    });
  }

  /**
   * Mark current entry as processed and advance
   */
  advance() {
    const entry = this.getCurrentEntry();
    if (entry) {
      this.processedIndices.add(this.currentIndex);
      this.currentIndex++;
      logger.debug('Advanced to next entry', {
        processed: entry.toString(),
        newIndex: this.currentIndex
      });
    }
    return entry;
  }

  /**
   * Mark a specific entry as processed (for out-of-order handling)
   */
  markProcessed(entry) {
    const index = entry.index;
    if (index === this.currentIndex) {
      // Normal case - advance
      return this.advance();
    }

    // Out of order - just mark as processed
    this.processedIndices.add(index);
    logger.debug('Marked out-of-order entry as processed', {
      entry: entry.toString(),
      index
    });

    // Advance current if we've caught up
    while (
      this.currentIndex < this.entries.length &&
      this.processedIndices.has(this.currentIndex)
    ) {
      this.currentIndex++;
    }
  }

  /**
   * Check if replay is complete
   */
  isComplete() {
    // Advance past any skipped entries
    this.getCurrentEntry();
    return this.currentIndex >= this.entries.length;
  }

  /**
   * Get progress summary
   */
  getProgress() {
    const total = this.entries.filter(e => !e.shouldSkip()).length;
    const processed = this.processedIndices.size;
    const remaining = total - processed;

    return {
      total,
      processed,
      remaining,
      currentEntry: this.getCurrentEntry()?.toString() || 'complete',
      progress: `${Math.round((processed / total) * 100)}%`
    };
  }

  /**
   * Get all entries (for debugging)
   */
  getAllEntries() {
    return this.entries.map(e => ({
      index: e.index,
      toString: e.toString(),
      processed: this.processedIndices.has(e.index)
    }));
  }

  /**
   * Find webhooks that should be triggered for a given LENDER request/response
   * Looks ahead in the log sequence to find LENDER->GW webhooks that:
   * 1. Share the same context (loanApplicationId, lenderOrgId)
   * 2. Occur between the LENDER request and response
   * @param {LogEntry} lenderRequestEntry - The GW->LENDER request entry
   * @param {LogEntry} lenderResponseEntry - The expected LENDER->GW response entry
   * @param {string} beforeOrAfter - 'before' or 'after' to find webhooks before or after response
   * @returns {Array<LogEntry>} - Array of webhook entries to trigger
   */
  findWebhooksForLenderCall(lenderRequestEntry, lenderResponseEntry, beforeOrAfter = 'before') {
    const webhooks = [];
    const requestIndex = lenderRequestEntry.index;
    const responseIndex = lenderResponseEntry ? lenderResponseEntry.index : this.entries.length;

    // Use correlation context to match webhooks to this LENDER call
    const contextKey = this.getContextKeyForMatching(lenderRequestEntry);

    // Look through entries between request and response
    for (let i = requestIndex + 1; i < responseIndex; i++) {
      const entry = this.entries[i];
      if (!entry || entry.shouldSkip()) continue;

      // Check if this is a LENDER->GW webhook
      if (!entry.isLenderToGwWebhook()) continue;

      // Check if webhook shares the same context
      const webhookContextKey = this.getContextKeyForMatching(entry);
      if (webhookContextKey === contextKey || this.contextsMatch(lenderRequestEntry, entry)) {
        // Determine if this webhook should come before or after the response
        // Webhooks before response are those that appear before the response entry
        // Webhooks after response appear between response and next LENDER interaction
        const isBefore = i < responseIndex;

        if (beforeOrAfter === 'before' && isBefore) {
          webhooks.push(entry);
        } else if (beforeOrAfter === 'after' && !isBefore) {
          // Actually this case won't hit here since we only scan up to responseIndex
          webhooks.push(entry);
        }
      }
    }

    return webhooks;
  }

  /**
   * Find webhooks that should be triggered AFTER the LENDER response
   * These are webhooks that appear after the response but before the next LENDER interaction
   * or before the GW->LSP response
   * @param {LogEntry} lenderResponseEntry - The LENDER->GW response entry
   * @param {LogEntry} gwToLspResponseEntry - The GW->LSP response entry (parent response)
   * @returns {Array<LogEntry>} - Array of webhook entries to trigger after response
   */
  findWebhooksAfterLenderResponse(lenderResponseEntry, gwToLspResponseEntry) {
    const webhooks = [];
    const startIndex = lenderResponseEntry ? lenderResponseEntry.index + 1 : 0;
    const endIndex = gwToLspResponseEntry ? gwToLspResponseEntry.index : this.entries.length;

    const responseContextKey = this.getContextKeyForMatching(lenderResponseEntry);

    for (let i = startIndex; i < endIndex; i++) {
      const entry = this.entries[i];
      if (!entry || entry.shouldSkip()) continue;

      // Stop if we hit another LENDER request or the GW->LSP response
      if (entry.source === 'GW' && entry.destination === 'LENDER') break;
      if (entry.source === 'GW' && entry.destination === 'LSP' && entry.isResponse) break;

      // Check if this is a LENDER->GW webhook
      if (!entry.isLenderToGwWebhook()) continue;

      // Check if webhook shares the same context
      const webhookContextKey = this.getContextKeyForMatching(entry);
      if (webhookContextKey === responseContextKey || this.contextsMatch(lenderResponseEntry, entry)) {
        webhooks.push(entry);
      }
    }

    return webhooks;
  }

  /**
   * Generate a context key for matching related entries
   * Uses loan_application_id, lender_org_id, order_id
   */
  getContextKeyForMatching(entry) {
    if (!entry) return '';
    const parts = [];
    if (entry.loanApplicationId) parts.push(entry.loanApplicationId);
    if (entry.lenderOrgId) parts.push(entry.lenderOrgId);
    if (entry.orderId) parts.push(entry.orderId);
    return parts.join(':');
  }

  /**
   * Check if two entries share the same context
   */
  contextsMatch(entryA, entryB) {
    if (!entryA || !entryB) return false;

    // Match by loan_application_id
    if (entryA.loanApplicationId && entryB.loanApplicationId) {
      if (entryA.loanApplicationId === entryB.loanApplicationId) return true;
    }

    // Match by lender_org_id
    if (entryA.lenderOrgId && entryB.lenderOrgId) {
      if (entryA.lenderOrgId === entryB.lenderOrgId) return true;
    }

    // Match by order_id
    if (entryA.orderId && entryB.orderId) {
      if (entryA.orderId === entryB.orderId) return true;
    }

    return false;
  }

}

export { LogEntry };
export default LogSequenceValidator;