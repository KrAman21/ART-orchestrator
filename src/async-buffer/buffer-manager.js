import { DeferredPromise } from './deferred-promise.js';
import { logger } from '../utils/logger.js';
import { canonicalRequestLogTag } from '../services/log-tag-normalizer.js';

export class BufferManager {
  constructor(config = {}) {
    this.incomingRequests = new Map();
    this.responseBuffer = new Map();
    this.pendingPromises = new Map();
    this.requestWaiters = new Set();
    this.sequenceCounter = 0;
    
    this.config = {
      maxBufferSize: 1000,
      defaultTimeoutMs: 60000,
      cleanupIntervalMs: 1000,
      completedRetentionMs: 5000,
      ...config
    };
    
    this.workCallbacks = [];
    this.hasWork = false;
    
    this._startCleanupTimer();
  }
  
  _startCleanupTimer() {
    this.cleanupTimer = setInterval(() => {
      this._cleanupExpiredEntries();
    }, this.config.cleanupIntervalMs);
  }

  stop() {
    if (this.cleanupTimer) {
      clearInterval(this.cleanupTimer);
      this.cleanupTimer = null;
    }

    for (const waiter of this.requestWaiters) {
      clearTimeout(waiter.timer);
    }
    this.requestWaiters.clear();
  }

  extractCorrelationIdentifiers(request = {}) {
    return {
      requestId: request.requestId || request.request_id || null,
      traceId: request.traceId || request.trace_id || request.payload?.traceId || request.payload?.trace_id || null,
      sequenceId: request.sequenceId || request.sequence_id || request.headers?.['x-sequence-id'] || null,
      loanApplicationId: request.loanApplicationId || request.loan_application_id || request.payload?.loanApplicationId || request.payload?.loan_application_id || null,
      lenderOrgId: request.lenderOrgId || request.lender_org_id || request.payload?.lenderOrgId || request.payload?.lender_org_id || request.payload?.themisDetail?.lenderOrgId || null
    };
  }
  
  generateKey(request) {
    const ids = this.extractCorrelationIdentifiers(request);
    const parts = [
      canonicalRequestLogTag(request.logTag),
      `${request.source}_${request.destination}`,
      ids.requestId || '',
      ids.traceId || '',
      ids.sequenceId || '',
      ids.loanApplicationId || '',
      ids.lenderOrgId || ''
    ].filter(Boolean);

    if (parts.length <= 2) {
      this.sequenceCounter += 1;
      parts.push(`seq-${this.sequenceCounter}`);
    }

    return parts.join(':');
  }
  
  async addIncomingRequest(request) {
    const key = this.generateKey(request);
    const existing = this.incomingRequests.get(key);

    if (existing && !this._isTerminalRequestState(existing.state)) {
      logger.warn('Duplicate request buffered, reusing existing wait handle', {
        key,
        state: existing.state,
        requestId: request.requestId || null,
        logTag: request.logTag
      });
      return existing;
    }

    if (this.incomingRequests.size >= this.config.maxBufferSize) {
      throw new Error('Incoming request buffer full');
    }
    
    const deferred = new DeferredPromise(this.config.defaultTimeoutMs);
    deferred.promise.catch(() => {});
    
    const entry = {
      request,
      deferred,
      timestamp: Date.now(),
      key,
      state: 'buffered',
      claimedAt: null,
      completedAt: null
    };
    
    this.incomingRequests.set(key, entry);
    
    logger.info('Request buffered', {
      key,
      bufferSize: this.incomingRequests.size,
      requestId: request.requestId || null,
      logTag: request.logTag,
      source: request.source,
      destination: request.destination
    });
    
    // Notify matching waiters AFTER logging to ensure proper ordering
    this._signalWorkAvailable();
    this._notifyMatchingWaiters(entry);
    
    return entry;
  }

  async waitForMatchingRequest(expectedEntry, timeoutMs = this.config.defaultTimeoutMs) {
    const claimed = this._claimOldestMatchingRequest(expectedEntry);
    if (claimed) {
      logger.info('Found and claimed buffered request immediately', {
        key: claimed.key,
        expected: expectedEntry.toString()
      });
      return claimed;
    }

    // Check if there's already a waiter for this expected entry
    for (const waiter of this.requestWaiters) {
      if (this._matchesRequest(waiter.expectedEntry, expectedEntry)) {
        logger.warn('Duplicate waiter detected, reusing existing waiter', {
          expected: expectedEntry.toString(),
          existingWaiter: waiter.expectedEntry.toString()
        });
        // Return the existing waiter's promise
        return new Promise((resolve) => {
          const originalResolve = waiter.resolve;
          waiter.resolve = (entry) => {
            originalResolve(entry);
            resolve(entry);
          };
        });
      }
    }

    logger.info('Waiting for buffered request match', {
      expected: expectedEntry.toString(),
      timeoutMs,
      currentBufferSize: this.incomingRequests.size
    });

    return new Promise(resolve => {
      const waiter = {
        expectedEntry,
        resolve: entry => {
          clearTimeout(waiter.timer);
          this.requestWaiters.delete(waiter);
          logger.info('Waiter resolved', {
            expected: expectedEntry.toString(),
            found: !!entry
          });
          resolve(entry);
        }
      };

      waiter.timer = setTimeout(() => {
        this.requestWaiters.delete(waiter);
        
        // Enhanced logging to debug matching issues
        const bufferedRequests = Array.from(this.incomingRequests.entries()).map(([key, entry]) => ({
          key,
          logTag: entry.request.logTag,
          source: entry.request.source,
          destination: entry.request.destination,
          state: entry.state,
          requestId: entry.request.requestId || null
        }));
        
        logger.error('Timeout waiting for matching request', {
          expected: expectedEntry.toString(),
          expectedLogTag: expectedEntry.logTag,
          expectedSource: expectedEntry.source,
          expectedDestination: expectedEntry.destination,
          timeoutMs,
          bufferedRequests,
          bufferSize: this.incomingRequests.size
        });
        resolve(null);
      }, timeoutMs);

      this.requestWaiters.add(waiter);
    });
  }

  completeIncomingRequest(key, response) {
    const entry = this.incomingRequests.get(key);
    if (!entry) {
      logger.warn('Attempted to complete missing buffered request', { key });
      return false;
    }

    entry.state = 'completed';
    entry.completedAt = Date.now();
    entry.deferred.resolve(response);

    logger.info('Response delivered', {
      key,
      requestId: entry.request.requestId || null,
      logTag: entry.request.logTag
    });

    return true;
  }

  failIncomingRequest(key, error) {
    const entry = this.incomingRequests.get(key);
    if (!entry) {
      logger.warn('Attempted to fail missing buffered request', {
        key,
        error: error.message
      });
      return false;
    }

    entry.state = error?.name === 'TimeoutError' ? 'timed_out' : 'failed';
    entry.completedAt = Date.now();
    entry.deferred.reject(error);

    logger.error('Buffered request failed', {
      key,
      requestId: entry.request.requestId || null,
      logTag: entry.request.logTag,
      error: error.message
    });

    return true;
  }
  
  addResponse(requestId, response, isError = false, metadata = {}) {
    if (this.responseBuffer.size >= this.config.maxBufferSize) {
      logger.error('Response buffer full, dropping response', { requestId });
      return;
    }
    
    this.responseBuffer.set(requestId, {
      response,
      isError,
      timestamp: Date.now(),
      metadata
    });
    
    this._signalWorkAvailable();
    
    const responsePreview = isError 
      ? { error: response.message, status: response.statusCode, data: response.data }
      : { status: response.status, statusText: response.statusText, data: response.data };
    
    logger.info('Added response to buffer', { 
      requestId, 
      bufferSize: this.responseBuffer.size,
      isError,
      response: responsePreview
    });
  }
  
  getResponseByMetadata(logTag, sourceDestination, loanApplicationId = null, lenderOrgId = null) {
    const baseTag = this._normalizeLogTag(logTag);
    const invertedSD = this._invertSourceDestination(sourceDestination);

    const candidates = [];
    for (const [requestId, entry] of this.responseBuffer) {
      const meta = entry.metadata || {};
      const metaTag = this._normalizeLogTag(meta.logTag);

      if (metaTag !== baseTag) continue;

      const metaSD = meta.sourceDestination;
      const sdMatch = metaSD === sourceDestination || metaSD === invertedSD;
      if (!sdMatch) continue;

      let score = metaSD === sourceDestination ? 10 : 5;

      if (loanApplicationId && meta.loanApplicationId === loanApplicationId) score += 20;
      if (lenderOrgId && meta.lenderOrgId === lenderOrgId) score += 15;

      candidates.push({ requestId, entry, score, timestamp: entry.timestamp });
    }

    if (candidates.length === 0) {
      logger.debug('No response found by metadata', {
        logTag,
        sourceDestination,
        loanApplicationId,
        lenderOrgId,
        invertedSD,
        bufferSize: this.responseBuffer.size
      });
      return null;
    }

    candidates.sort((a, b) => {
      if (b.score !== a.score) return b.score - a.score;
      return a.timestamp - b.timestamp;
    });

    const best = candidates[0];
    this.responseBuffer.delete(best.requestId);

    logger.info('Found buffered response by metadata', {
      logTag,
      sourceDestination,
      matchedSD: best.entry.metadata?.sourceDestination,
      matchedRequestId: best.requestId,
      score: best.score,
      totalCandidates: candidates.length,
      loanApplicationId,
      lenderOrgId,
      usedInvertedMatch: best.entry.metadata?.sourceDestination === invertedSD
    });

    return best.entry;
  }

  _normalizeLogTag(tag) {
    return (tag || '')
      .replace(/_REQUEST$/i, '')
      .replace(/_RESPONSE$/i, '')
      .replace(/_OUTGOING$/i, '')
      .replace(/_INCOMING$/i, '');
  }

  _invertSourceDestination(sd) {
    if (!sd || typeof sd !== 'string') return null;
    const parts = sd.split('_');
    if (parts.length !== 2) return null;
    return `${parts[1]}_${parts[0]}`;
  }
  
  registerPendingPromise(requestId, entry, timeoutMs = null) {
    const deferred = new DeferredPromise(timeoutMs || this.config.defaultTimeoutMs);
    
    const pending = {
      entry,
      deferred,
      timestamp: Date.now()
    };
    
    this.pendingPromises.set(requestId, pending);
    
    logger.info('Registered pending promise', { requestId });
    
    return deferred;
  }
  
  resolvePendingPromise(requestId, result, isError = false) {
    const pending = this.pendingPromises.get(requestId);
    
    if (!pending) {
      logger.warn('No pending promise found for requestId', { requestId });
      return false;
    }
    
    if (isError) {
      pending.deferred.reject(result);
    } else {
      pending.deferred.resolve(result);
    }
    
    this.pendingPromises.delete(requestId);
    
    logger.info('Resolved pending promise', { requestId, isError });
    
    return true;
  }
  
  getResponse(requestId) {
    const entry = this.responseBuffer.get(requestId);
    if (entry) {
      this.responseBuffer.delete(requestId);
      return entry;
    }
    return null;
  }
  
  findMatchingRequest(expectedEntry) {
    const matches = [];
    
    logger.debug('Finding matching request', {
      expected: expectedEntry.toString(),
      expectedLogTag: expectedEntry.logTag,
      expectedSource: expectedEntry.source,
      expectedDestination: expectedEntry.destination,
      bufferSize: this.incomingRequests.size
    });
    
    for (const [key, entry] of this.incomingRequests) {
      if (entry.state === 'buffered' && this._matchesEntry(entry.request, expectedEntry)) {
        matches.push({ key, entry });
      }
    }
    
    if (matches.length === 0) {
      logger.debug('No matching requests found', {
        expected: expectedEntry.toString(),
        bufferSize: this.incomingRequests.size,
        bufferedStates: Array.from(this.incomingRequests.values()).map(e => ({
          logTag: e.request.logTag,
          source: e.request.source,
          dest: e.request.destination,
          state: e.state
        }))
      });
      return null;
    }
    
    matches.sort((a, b) => a.entry.timestamp - b.entry.timestamp);
    const oldest = matches[0];
    
    oldest.entry.state = 'claimed';
    oldest.entry.claimedAt = Date.now();
    
    logger.info('Request matched', {
      key: oldest.key,
      bufferSize: this.incomingRequests.size,
      totalMatches: matches.length,
      bufferedAt: oldest.entry.timestamp,
      claimedAt: oldest.entry.claimedAt,
      waitTime: oldest.entry.claimedAt - oldest.entry.timestamp,
      expected: expectedEntry.toString()
    });
    
    return oldest.entry;
  }
  
  _matchesRequest(incoming, expected) {
    const incomingLogTag = canonicalRequestLogTag(incoming.logTag);
    const expectedLogTag = canonicalRequestLogTag(expected.logTag);
    
    if (incomingLogTag !== expectedLogTag) {
      logger.debug('LogTag mismatch', {
        incoming: incomingLogTag,
        expected: expectedLogTag
      });
      return false;
    }
    
    if (incoming.source !== expected.source) {
      logger.debug('Source mismatch', {
        incoming: incoming.source,
        expected: expected.source
      });
      return false;
    }
    
    if (incoming.destination !== expected.destination) {
      logger.debug('Destination mismatch', {
        incoming: incoming.destination,
        expected: expected.destination
      });
      return false;
    }
    
    return true;
  }
  
  _matchesEntry(request, expectedEntry) {
    return this._matchesRequest(request, expectedEntry);
  }
  
  onWorkAvailable(callback) {
    this.workCallbacks.push(callback);
  }
  
  _signalWorkAvailable() {
    this.hasWork = true;
    this.workCallbacks.forEach(cb => {
      try {
        cb();
      } catch (e) {
        logger.error('Work callback error', { error: e.message });
      }
    });
  }
  
  async waitForWork(timeoutMs = 100) {
    if (this.hasWork) {
      this.hasWork = false;
      return true;
    }
    
    return new Promise(resolve => {
      const timer = setTimeout(() => {
        resolve(false);
      }, timeoutMs);
      
      const callback = () => {
        clearTimeout(timer);
        resolve(true);
      };
      
      this.workCallbacks.push(callback);
    });
  }
  
  _cleanupExpiredEntries() {
    const now = Date.now();
    const expired = [];
    
    for (const [key, entry] of this.incomingRequests) {
      if (entry.state === 'buffered' && now - entry.timestamp > this.config.defaultTimeoutMs) {
        expired.push(key);
      } else if (
        this._isTerminalRequestState(entry.state) &&
        entry.completedAt &&
        now - entry.completedAt > this.config.completedRetentionMs
      ) {
        this.incomingRequests.delete(key);
      }
    }
    
    expired.forEach(key => {
      const entry = this.incomingRequests.get(key);
      if (entry) {
        const error = new Error('Request expired in buffer');
        error.name = 'TimeoutError';
        this.failIncomingRequest(key, error);
      }
    });
    
    if (expired.length > 0) {
      logger.info('Cleaned up expired incoming requests', { count: expired.length });
    }
    
    const expiredResponses = [];
    for (const [key, entry] of this.responseBuffer) {
      if (now - entry.timestamp > this.config.defaultTimeoutMs) {
        expiredResponses.push(key);
      }
    }
    
    expiredResponses.forEach(key => this.responseBuffer.delete(key));
    
    if (expiredResponses.length > 0) {
      logger.info('Cleaned up expired responses', { count: expiredResponses.length });
    }
  }
  
  getStats() {
    return {
      incomingRequests: this.incomingRequests.size,
      responseBuffer: this.responseBuffer.size,
      pendingPromises: this.pendingPromises.size
    };
  }
  
  clear() {
    this.stop();
    this.incomingRequests.clear();
    this.responseBuffer.clear();
    this.pendingPromises.clear();
  }

  _isTerminalRequestState(state) {
    return state === 'completed' || state === 'failed' || state === 'timed_out';
  }

  /**
   * Immediately resolve any pending waiter for a given expected entry with null.
   * Used when an entry is mocked/skipped externally (e.g. via mockExternalRequest)
   * so the replay thread doesn't have to wait the full timeout.
   */
  skipWaiter(expectedEntry) {
    for (const waiter of this.requestWaiters) {
      if (this._matchesRequest(waiter.expectedEntry, expectedEntry)) {
        clearTimeout(waiter.timer);
        this.requestWaiters.delete(waiter);
        logger.info('Waiter skipped (entry mocked externally)', {
          expected: expectedEntry.toString()
        });
        waiter.resolve(null);
        return true;
      }
    }
    return false;
  }

  _claimOldestMatchingRequest(expectedEntry) {
    return this.findMatchingRequest(expectedEntry);
  }

  _notifyMatchingWaiters(entry) {
    if (this._isTerminalRequestState(entry.state)) {
      return;
    }

    for (const waiter of this.requestWaiters) {
      if (!this._matchesEntry(entry.request, waiter.expectedEntry)) {
        continue;
      }

      if (entry.state === 'buffered') {
        entry.state = 'claimed';
        entry.claimedAt = Date.now();
        
        logger.info('Request matched via notify', {
          key: entry.key,
          bufferSize: this.incomingRequests.size,
          totalMatches: 1,
          bufferedAt: entry.timestamp,
          claimedAt: entry.claimedAt,
          waitTime: entry.claimedAt - entry.timestamp,
          expected: waiter.expectedEntry.toString()
        });
      } else {
        logger.warn('Request already claimed, skipping notify', {
          key: entry.key,
          state: entry.state,
          expected: waiter.expectedEntry.toString()
        });
        continue;
      }

      waiter.resolve(entry);
      return;
    }
  }
}
