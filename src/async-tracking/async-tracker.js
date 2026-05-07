import { logger } from '../utils/logger.js';

/**
 * AsyncTracker - Handles async call tracking for the orchestrator
 *
 * Manages count-based async tracking for out-of-order processing,
 * including tracking of pending external requests and webhook triggers.
 */
export class AsyncTracker {
  /**
   * @param {Object} options - Dependencies and configuration
   * @param {Map} options.asyncCallTracker - Map for tracking async calls
   * @param {Map} options.pendingExternalRequests - Map for pending external requests
   * @param {Set} options.triggeredWebhooks - Set of triggered webhooks
   * @param {Object} options.logger - Logger instance
   * @param {Object} options.validator - LogSequenceValidator instance
   * @param {Object} options.config - Configuration object
   * @param {Object} options.callbacks - Callback functions
   * @param {Function} options.callbacks.getContextKey - Function to get context key from entry
   * @param {Function} options.callbacks.triggerWebhooks - Function to trigger webhooks
   * @param {Function} options.callbacks.triggerAppWebhooksAfterResponse - Function to trigger APP->GW webhooks after response
   * @param {Function} options.callbacks.sleep - Function to sleep/delay
   */
  constructor({
    asyncCallTracker,
    pendingExternalRequests,
    triggeredWebhooks,
    logger: loggerInstance,
    validator,
    config,
    callbacks
  }) {
    this.asyncCallTracker = asyncCallTracker || new Map();
    this.pendingExternalRequests = pendingExternalRequests || new Map();
    this.triggeredWebhooks = triggeredWebhooks || new Set();
    this.logger = loggerInstance || logger;
    this.validator = validator;
    this.config = {
      timeoutMs: 10000,
      ...config
    };
    this.callbacks = callbacks || {};
  }

  /**
   * Generate a context key for matching requests and responses
   * Based on loan_application_id, lender_org_id, or order_id
   * @param {Object} entry - The log entry
   * @returns {string} - The context key
   */
  getContextKey(entry) {
    if (this.callbacks.getContextKey) {
      return this.callbacks.getContextKey(entry);
    }
    
    // Fallback implementation
    const parts = [];
    if (entry.loanApplicationId) {
      parts.push(entry.loanApplicationId);
    }
    if (entry.lenderOrgId) {
      parts.push(entry.lenderOrgId);
    }
    // Use order_id as fallback correlation since it's present across multiple entries
    if (parts.length === 0 && entry.orderId) {
      return entry.orderId;
    }
    return parts.join(':') || entry.requestId || `${entry.index}`;
  }

  /**
   * Sleep/delay helper
   * @param {number} ms - Milliseconds to sleep
   * @returns {Promise<void>}
   */
  async sleep(ms) {
    if (this.callbacks.sleep) {
      return this.callbacks.sleep(ms);
    }
    // Fallback implementation
    return new Promise(resolve => setTimeout(resolve, ms));
  }

  /**
   * Wait for pending external requests related to the current entry.
   * @param {Object} currentEntry - The current log entry
   * @returns {Promise<void>}
   */
  async waitForPendingExternalRequests(currentEntry) {
    // Find pending external requests related to this flow
    // Match by loan_application_id or lender_org_id context
    const promisesToWait = [];

    for (const [contextKey, pendingInfo] of this.pendingExternalRequests.entries()) {
      // Check if this pending request relates to the current entry
      const currentContextKey = this.getContextKey(currentEntry);

      // Match if context keys are the same or share loan_application_id/lender_org_id
      let isRelated = false;
      if (contextKey === currentContextKey) {
        isRelated = true;
      } else if (currentEntry.loanApplicationId && pendingInfo.requestEntry && pendingInfo.requestEntry.loanApplicationId) {
        isRelated = currentEntry.loanApplicationId === pendingInfo.requestEntry.loanApplicationId;
      } else if (currentEntry.lenderOrgId && pendingInfo.requestEntry && pendingInfo.requestEntry.lenderOrgId) {
        isRelated = currentEntry.lenderOrgId === pendingInfo.requestEntry.lenderOrgId;
      }

      if (isRelated) {
        this.logger.info('Waiting for pending external request', {
          contextKey,
          currentEntry: currentEntry.toString ? currentEntry.toString() : String(currentEntry),
          pendingRequest: pendingInfo.requestEntry && pendingInfo.requestEntry.toString ? pendingInfo.requestEntry.toString() : String(pendingInfo.requestEntry)
        });
        promisesToWait.push(pendingInfo.promise);
      }
    }

    if (promisesToWait.length > 0) {
      this.logger.info(`Waiting for ${promisesToWait.length} pending external request(s)`, {
        currentEntry: currentEntry.toString ? currentEntry.toString() : String(currentEntry)
      });

      try {
        await Promise.all(promisesToWait);
        this.logger.info('All pending external requests completed', {
          currentEntry: currentEntry.toString ? currentEntry.toString() : String(currentEntry)
        });
      } catch (error) {
        this.logger.error('Error waiting for pending external requests', {
          currentEntry: currentEntry.toString ? currentEntry.toString() : String(currentEntry),
          error: error.message
        });
        // Don't throw - we still want to return the response even if external call times out
        // The external call failure will be tracked separately
      }
    }
  }

  /**
   * Initialize async call tracking for a parent request.
   * Pre-scans logs to count expected async calls between request and response.
   * @param {Object} parentRequestEntry - The parent request (e.g., LSP->GW)
   * @returns {string} - The context key for tracking
   */
  initializeAsyncTracking(parentRequestEntry) {
    const contextKey = this.getContextKey(parentRequestEntry);

    // Pre-scan to count expected async calls
    const asyncInfo = this.validator.countExpectedAsyncCalls(
      this.validator.currentIndex,
      contextKey
    );

    // Initialize tracking
    this.asyncCallTracker.set(contextKey, {
      expected: asyncInfo.count,
      actual: 0,
      entries: new Set(),
      parentRequestEntry,
      parentResponseEntry: asyncInfo.parentResponseIndex !== null
        ? this.validator.entries[asyncInfo.parentResponseIndex]
        : null,
      expectedEntries: asyncInfo.entries
    });

    this.logger.info('Initialized async call tracking', {
      contextKey,
      expectedCount: asyncInfo.count,
      asyncEntries: asyncInfo.entries.map(e => ({
        index: e.index,
        lenderOrgId: e.lenderOrgId,
        logTag: e.logTag
      }))
    });

    return contextKey;
  }

  /**
   * Track a completed async call by lenderOrgId.
   * @param {string} contextKey - The tracking context key
   * @param {Object} entry - The completed entry
   * @returns {boolean} - True if all async calls for this context are complete
   */
  trackAsyncCompletion(contextKey, entry) {
    const tracker = this.asyncCallTracker.get(contextKey);
    if (!tracker) {
      this.logger.warn('No async tracker found for context', { contextKey });
      return false;
    }

    // Track by index to avoid double-counting
    if (tracker.entries.has(entry.index)) {
      this.logger.debug('Async entry already tracked', { index: entry.index });
      return tracker.actual >= tracker.expected;
    }

    tracker.entries.add(entry.index);
    tracker.actual++;

    const isComplete = tracker.actual >= tracker.expected;

    this.logger.info('Tracked async completion', {
      contextKey,
      lenderOrgId: entry.lenderOrgId,
      index: entry.index,
      actual: tracker.actual,
      expected: tracker.expected,
      isComplete
    });

    return isComplete;
  }

  /**
   * Check if all async calls are complete for a given context.
   * @param {string} contextKey - The tracking context key
   * @returns {boolean}
   */
  isAsyncComplete(contextKey) {
    const tracker = this.asyncCallTracker.get(contextKey);
    if (!tracker) return true; // No tracking = nothing to wait for
    return tracker.actual >= tracker.expected;
  }

  /**
   * Get the expected async call count for a context.
   * @param {string} contextKey - The tracking context key
   * @returns {number}
   */
  getExpectedAsyncCount(contextKey) {
    const tracker = this.asyncCallTracker.get(contextKey);
    return tracker ? tracker.expected : 0;
  }

  /**
   * Clean up async tracking for a context.
   * @param {string} contextKey - The tracking context key
   */
  cleanupAsyncTracking(contextKey) {
    if (this.asyncCallTracker.has(contextKey)) {
      this.logger.debug('Cleaning up async tracking', { contextKey });
      this.asyncCallTracker.delete(contextKey);
    }
  }

  /**
   * Wait for all pending external calls to complete.
   * Uses count-based completion: waits until actual processed count matches expected count.
   * This ensures that when LSP->GW is processed, all GW->LENDER calls complete
   * before returning GW->LSP response.
   * @returns {Promise<void>}
   */
  async waitForAllExternalCalls() {
    // First check if we're using count-based tracking
    for (const [contextKey, tracker] of this.asyncCallTracker.entries()) {
      if (tracker.expected > 0 && tracker.actual < tracker.expected) {
        this.logger.info(`Waiting for async calls to complete (count-based)`, {
          contextKey,
          actual: tracker.actual,
          expected: tracker.expected
        });

        // Poll until completion or timeout
        const startTime = Date.now();
        const timeoutMs = this.config.timeoutMs || 10000;

        while (tracker.actual < tracker.expected) {
          if (Date.now() - startTime > timeoutMs) {
            this.logger.warn(`Timeout waiting for async calls`, {
              contextKey,
              actual: tracker.actual,
              expected: tracker.expected
            });
            break;
          }
          // Wait a bit before checking again
          await this.sleep(100);
        }

        this.logger.info(`Async calls completion status`, {
          contextKey,
          actual: tracker.actual,
          expected: tracker.expected,
          complete: tracker.actual >= tracker.expected
        });
      }
    }

    // Also wait for any tracked external requests (webhook-based tracking)
    if (this.pendingExternalRequests.size > 0) {
      this.logger.info(`Waiting for ${this.pendingExternalRequests.size} external call(s) to complete`);

      const promisesToWait = [];
      for (const [, pendingInfo] of this.pendingExternalRequests.entries()) {
        promisesToWait.push(pendingInfo.promise);
      }

      if (promisesToWait.length > 0) {
        try {
          await Promise.all(promisesToWait);
          this.logger.info('All external calls completed');
        } catch (error) {
          this.logger.error('Some external calls failed', {
            error: error.message
          });
          // Don't throw - continue with response
        }
      }
    }

    // After all external calls complete, trigger any post-response webhooks (CASE 7)
    // Note: This requires pendingPostResponseWebhooks to be passed in or available
    if (this.pendingPostResponseWebhooks && this.pendingPostResponseWebhooks.size > 0) {
      for (const [contextKey, webhooks] of this.pendingPostResponseWebhooks.entries()) {
        this.logger.info(`Triggering ${webhooks.length} post-response webhook(s) for ${contextKey}`);
        if (this.callbacks.triggerWebhooks) {
          await this.callbacks.triggerWebhooks(webhooks);
        }
      }
      this.pendingPostResponseWebhooks.clear();
    }

    // Also find and trigger APP->GW webhooks that should fire after GW->APP response
    if (this.callbacks.triggerAppWebhooksAfterResponse) {
      await this.callbacks.triggerAppWebhooksAfterResponse();
    }
  }

  /**
   * Set pending post-response webhooks (used by waitForAllExternalCalls)
   * @param {Map} pendingPostResponseWebhooks - Map of pending post-response webhooks
   */
  setPendingPostResponseWebhooks(pendingPostResponseWebhooks) {
    this.pendingPostResponseWebhooks = pendingPostResponseWebhooks;
  }
}

export default AsyncTracker;
