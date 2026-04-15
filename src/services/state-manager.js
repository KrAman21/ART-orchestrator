import { logger } from '../utils/logger.js';

/**
 * PendingRequest represents an in-flight request waiting for response
 */
class PendingRequest {
  constructor(correlationId, expectedLogEntry, timeoutMs = 10000) {
    this.correlationId = correlationId;
    this.expectedLogEntry = expectedLogEntry;
    this.createdAt = Date.now();
    this.timeoutMs = timeoutMs;
    this.resolve = null;
    this.reject = null;
    this.timedOut = false;

    // Create promise that can be resolved externally
    this.promise = new Promise((resolve, reject) => {
      this.resolve = resolve;
      this.reject = reject;
    });

    // Set up timeout
    this.timeoutHandle = setTimeout(() => {
      this.timedOut = true;
      this.reject(new Error(
        `Request ${correlationId} timed out after ${timeoutMs}ms. ` +
        `Expected response for: ${expectedLogEntry?.message?.log_tag}`
      ));
    }, timeoutMs);
  }

  complete(response) {
    if (this.timedOut) return false;
    clearTimeout(this.timeoutHandle);
    this.resolve(response);
    return true;
  }

  fail(error) {
    if (this.timedOut) return false;
    clearTimeout(this.timeoutHandle);
    this.reject(error);
    return true;
  }
}

/**
 * StateManager handles:
 * - Pending requests waiting for responses
 * - Early responses that arrive before their turn in the log sequence
 * - Correlation tracking between requests and responses
 */
export class StateManager {
  constructor(config = {}) {
    // Map<correlationId, PendingRequest>
    this.pendingRequests = new Map();

    // Map<correlationId, responseData> - responses that arrived early
    this.pendingResponses = new Map();

    // Map<requestKey, requestData> - requests received but not yet processed
    // requestKey format: "source_destination|api|correlationId"
    this._bufferedRequests = new Map();

    // Map to store response headers per correlation key
    this.responseHeaders = new Map();

    this.config = {
      defaultTimeoutMs: 10000,
      maxBufferedResponses: 100,
      maxBufferedRequests: 100,
      ...config
    };
  }

  /**
   * Register a new pending request that we're expecting a response for
   * @param {string} correlationId - Unique identifier for this request-response pair
   * @param {Object} expectedLogEntry - The expected log entry from the sequence
   * @returns {Promise} - Resolves when response is received
   */
  registerPendingRequest(correlationId, expectedLogEntry) {
    // Check if response already arrived early
    if (this.pendingResponses.has(correlationId)) {
      const earlyResponse = this.pendingResponses.get(correlationId);
      this.pendingResponses.delete(correlationId);
      logger.debug('Using early-arrived response', { correlationId });
      return Promise.resolve(earlyResponse);
    }

    // Create new pending request
    const pending = new PendingRequest(
      correlationId,
      expectedLogEntry,
      this.config.defaultTimeoutMs
    );

    this.pendingRequests.set(correlationId, pending);
    logger.debug('Registered pending request', {
      correlationId,
      pendingCount: this.pendingRequests.size
    });

    return pending.promise;
  }

  /**
   * Handle an incoming response - either match with pending request or buffer
   * @param {string} correlationId - The correlation ID
   * @param {Object} responseData - The response payload
   * @returns {boolean} - True if matched with pending request, false if buffered
   */
  handleIncomingResponse(correlationId, responseData) {
    // Check if we have a pending request waiting
    const pending = this.pendingRequests.get(correlationId);
    if (pending) {
      const completed = pending.complete(responseData);
      this.pendingRequests.delete(correlationId);
      logger.debug('Response matched with pending request', {
        correlationId,
        completed
      });
      return true;
    }

    // Buffer for later (early response)
    if (this.pendingResponses.size >= this.config.maxBufferedResponses) {
      logger.warn('Pending responses buffer full, dropping oldest');
      const firstKey = this.pendingResponses.keys().next().value;
      this.pendingResponses.delete(firstKey);
    }

    this.pendingResponses.set(correlationId, responseData);
    logger.debug('Buffered early response', {
      correlationId,
      bufferedCount: this.pendingResponses.size
    });
    return false;
  }

  /**
   * Buffer an incoming request that arrived before its turn in log sequence
   * @param {string} requestKey - Unique key for this request
   * @param {Object} requestData - The request payload and metadata
   */
  bufferIncomingRequest(requestKey, requestData) {
    if (this._bufferedRequests.size >= this.config.maxBufferedRequests) {
      logger.warn('Buffered requests buffer full, dropping oldest');
      const firstKey = this._bufferedRequests.keys().next().value;
      this._bufferedRequests.delete(firstKey);
    }

    this._bufferedRequests.set(requestKey, {
      data: requestData,
      receivedAt: Date.now()
    });

    logger.debug('Buffered early request', {
      requestKey,
      bufferedCount: this._bufferedRequests.size
    });
  }

  /**
   * Retrieve a buffered request if present
   * @param {string} requestKey - The key to look up
   * @returns {Object|null} - The buffered request data or null
   */
  retrieveBufferedRequest(requestKey) {
    const buffered = this._bufferedRequests.get(requestKey);
    if (buffered) {
      this._bufferedRequests.delete(requestKey);
      logger.debug('Retrieved buffered request', { requestKey });
      return buffered.data;
    }
    return null;
  }

  /**
   * Check if a request is already buffered
   * @param {string} requestKey - The key to check
   * @returns {boolean}
   */
  hasBufferedRequest(requestKey) {
    return this._bufferedRequests.has(requestKey);
  }

  /**
   * Find a buffered request matching the expected entry criteria
   * @param {Object} criteria - { source, destination, logTag }
   * @returns {Object|null} - { key, data } or null if not found
   */
  findBufferedRequest(criteria) {
    for (const [key, entry] of this._bufferedRequests.entries()) {
      const data = entry.data;
      if (
        data.source === criteria.source &&
        data.destination === criteria.destination &&
        data.logTag === criteria.logTag
      ) {
        // For async parallel calls, also check lenderOrgId if provided
        if (criteria.lenderOrgId && data.lenderOrgId) {
          if (data.lenderOrgId !== criteria.lenderOrgId) {
            continue;
          }
        }
        return { key, data };
      }
    }
    return null;
  }

  /**
   * Remove a buffered request by key
   * @param {string} requestKey - The key to remove
   */
  removeBufferedRequest(requestKey) {
    const existed = this._bufferedRequests.delete(requestKey);
    if (existed) {
      logger.debug('Removed buffered request', { requestKey });
    }
    return existed;
  }

  /**
   * Find a buffered request by lenderOrgId
   * @param {string} lenderOrgId - The lender org ID to match
   * @returns {Object|null} - { key, data } or null
   */
  findBufferedRequestByLenderOrgId(lenderOrgId) {
    for (const [key, entry] of this._bufferedRequests.entries()) {
      const data = entry.data;
      if (data.lenderOrgId === lenderOrgId) {
        return { key, data };
      }
    }
    return null;
  }

  /**
   * Store response headers for a correlation key
   * @param {string} correlationKey - The correlation key
   * @param {Object} headers - Response headers
   */
  storeResponseHeaders(correlationKey, headers) {
    this.responseHeaders.set(correlationKey, headers);
    logger.debug('Stored response headers', { correlationKey, headerKeys: Object.keys(headers) });
  }

  /**
   * Get stored response headers for a correlation key
   * @param {string} correlationKey - The correlation key
   * @returns {Object|null} - The headers or null
   */
  getResponseHeaders(correlationKey) {
    const headers = this.responseHeaders.get(correlationKey);
    if (headers) {
      this.responseHeaders.delete(correlationKey);
      logger.debug('Retrieved response headers', { correlationKey, headerKeys: Object.keys(headers) });
    }
    return headers || null;
  }

  /**
   * Generate a correlation key for request-response pairing
   * @param {string} api - API identifier
   * @param {string} sourceDestination - Source to destination (e.g., "LSP_TO_GW")
   * @param {string} requestId - Request ID from trace
   * @returns {string}
   */
  static generateCorrelationKey(api, sourceDestination, requestId) {
    // Use requestId as primary correlation, fallback to composite key
    return requestId || `${sourceDestination}:${api}:${Date.now()}`;
  }

  /**
   * Generate a request key for buffering incoming requests
   * @param {string} source - Source service (LSP, GW)
   * @param {string} api - API endpoint/path
   * @param {string} requestId - Request ID
   * @returns {string}
   */
  static generateRequestKey(source, api, requestId) {
    return `${source}|${api}|${requestId}`;
  }

  /**
   * Clean up any stale entries
   */
  cleanup() {
    const now = Date.now();
    const maxAge = this.config.defaultTimeoutMs * 2;

    // Clean old buffered requests
    for (const [key, entry] of this._bufferedRequests.entries()) {
      if (now - entry.receivedAt > maxAge) {
        this._bufferedRequests.delete(key);
        logger.debug('Cleaned up stale buffered request', { key });
      }
    }

    // Clean old pending responses
    // Note: pending requests have their own timeout handling

    logger.info('StateManager cleanup completed', {
      pendingRequests: this.pendingRequests.size,
      pendingResponses: this.pendingResponses.size,
      bufferedRequests: this._bufferedRequests.size
    });
  }

  /**
   * Get current state summary
   */
  getState() {
    return {
      pendingRequests: this.pendingRequests.size,
      pendingResponses: this.pendingResponses.size,
      bufferedRequests: this._bufferedRequests.size,
      pendingRequestIds: Array.from(this.pendingRequests.keys()),
      bufferedResponseIds: Array.from(this.pendingResponses.keys())
    };
  }

  /**
   * Iterate over buffered requests
   * @yields {[string, Object]} [key, entry] pairs
   */
  *iterateBufferedRequests() {
    for (const [key, entry] of this._bufferedRequests) {
      yield [key, entry];
    }
  }
}

export default StateManager;
