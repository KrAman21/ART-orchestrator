import { logger } from '../utils/logger.js';

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
    let rawSourceDestination = this.message.source_destination || '';
    rawSourceDestination = this.remapWrapperSourceDestination(rawSourceDestination);

    this.sourceDestination = rawSourceDestination;
    const parts = this.sourceDestination.split('_');
    this.source = parts[0] || '';
    this.destination = parts[1] || '';

    // Log tag and type
    this.logTag = (this.message.log_tag || '').trim();
    this.isRequest = this.logTag.endsWith('Request') || this.logTag.endsWith('_INCOMING');
    this.isResponse = this.logTag.endsWith('Response') || this.logTag.endsWith('_OUTGOING');

    // Extract payload based on type
    this.payload = this.isRequest
      ? this.message.trace_request
      : (this.message.trace_response || this.message.trace_error_msg);

    // Correlation info
    this.requestId = this.message.request_id || this.xRequestId;
    this.loanApplicationId = this.message.loan_application_id;
    this.lenderOrgId = this.message.lender_org_id;
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
    // Skip entries that should be skipped
    while (
      this.currentIndex < this.entries.length &&
      this.entries[this.currentIndex].shouldSkip()
    ) {
      logger.debug('Skipping WRAPPER entry', {
        index: this.currentIndex,
        entry: this.entries[this.currentIndex].toString()
      });
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

    if (!currentEntry) {
      return {
        valid: false,
        expectedEntry: null,
        error: 'No more entries to process - unexpected request received'
      };
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
      const lookahead = this.peekNext(5);
      const foundInLookahead = lookahead.find(entry =>
        entry.isRequest &&
        entry.source === incoming.source &&
        entry.destination === incoming.destination &&
        entry.logTag === incoming.logTag
      );

      if (foundInLookahead) {
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
    return (
      expected.source === incoming.source &&
      expected.destination === incoming.destination &&
      expected.logTag === incoming.logTag
    );
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
}

export { LogEntry };
export default LogSequenceValidator;