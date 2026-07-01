import { DeferredPromise } from './deferred-promise.js';
import { logger } from '../utils/logger.js';
import { canonicalRequestLogTag } from '../services/log-tag-normalizer.js';
import { compareLog } from '../services/comparator.js';

const PAYLOAD_SIGNAL_WEIGHTS = [
  ['loanApplicationStatus', 250],
  ['status', 120],
  ['offerType', 80],
  ['errorCode', 70],
  ['message', 40],
  ['loanMetadata.isLenderApproved', 120],
  ['result.status', 100]
];

export class BufferManager {
  constructor(config = {}) {
    this.incomingRequests = new Map();
    this.responseBuffer = new Map();
    this.pendingPromises = new Map();
    this.requestWaiters = new Set();
    this.replayFallbackIncomingRequests = new Map();
    this.replayFallbackResponses = new Map();
    this.sequenceCounter = 0;
    this.lastMatchTimeout = null;
    
    this.config = {
      maxBufferSize: 1000,
      defaultTimeoutMs: 60000,
      cleanupIntervalMs: 1000,
      completedRetentionMs: 5000,
      preservedReplayFallbackWaitMs: 5000,
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

  _cancelAllWaiters() {
    for (const waiter of Array.from(this.requestWaiters)) {
      waiter.resolve(null);
    }
  }

  _failBufferedIncomingRequests(message) {
    for (const [key, entry] of this.incomingRequests.entries()) {
      entry.state = 'failed';
      entry.completedAt = Date.now();
      entry.deferred.reject(new Error(message));
      this.incomingRequests.delete(key);
    }
  }

  _isGatewayLenderRequest(request = {}) {
    return request?.source === 'GATEWAY' && request?.destination === 'LENDER';
  }

  _isGatewayLenderResponse(entry = {}) {
    return entry?.metadata?.sourceDestination === 'GATEWAY_LENDER';
  }

  _buildReplayDuplicateKey(baseKey) {
    this.sequenceCounter += 1;
    return `${baseKey}:replay-${this.sequenceCounter}`;
  }

  _resetPreservedIncomingEntry(entry) {
    const deferred = new DeferredPromise(this.config.defaultTimeoutMs);
    deferred.promise.catch(() => {});

    entry.deferred = deferred;
    entry.state = 'buffered';
    entry.claimedAt = null;
    entry.completedAt = null;
    entry.preservedOnRewind = true;
    entry.preservedAt = Date.now();

    return entry;
  }

  _storeIncomingReplayFallback(entry) {
    if (!entry?.key || !entry?.request) {
      return;
    }

    if (!this._isGatewayLenderRequest(entry.request)) {
      return;
    }

    this.replayFallbackIncomingRequests.set(entry.key, {
      key: entry.key,
      request: entry.request,
      timestamp: entry.timestamp,
      completedAt: entry.completedAt || Date.now()
    });
  }

  _storeResponseReplayFallback(requestId, entry) {
    if (!requestId || !this._isGatewayLenderResponse(entry)) {
      return;
    }

    this.replayFallbackResponses.set(requestId, {
      response: entry.response,
      isError: entry.isError,
      timestamp: entry.timestamp,
      metadata: {
        ...(entry.metadata || {})
      }
    });
  }

  _rehydrateReplayFallbacks() {
    for (const fallback of this.replayFallbackIncomingRequests.values()) {
      if (this.incomingRequests.has(fallback.key)) {
        continue;
      }

      const deferred = new DeferredPromise(this.config.defaultTimeoutMs);
      deferred.promise.catch(() => {});

      this.incomingRequests.set(fallback.key, {
        request: fallback.request,
        deferred,
        timestamp: fallback.timestamp,
        key: fallback.key,
        state: 'buffered',
        claimedAt: null,
        completedAt: null,
        preservedOnRewind: true,
        preservedAt: Date.now()
      });
    }

    for (const [requestId, fallback] of this.replayFallbackResponses.entries()) {
      if (this.responseBuffer.has(requestId)) {
        continue;
      }

      this.responseBuffer.set(requestId, {
        response: fallback.response,
        isError: fallback.isError,
        timestamp: fallback.timestamp,
        metadata: {
          ...(fallback.metadata || {}),
          preservedOnRewind: true
        },
        preservedOnRewind: true
      });
    }
  }

  stop() {
    if (this.cleanupTimer) {
      clearInterval(this.cleanupTimer);
      this.cleanupTimer = null;
    }

    this._cancelAllWaiters();
  }

  extractCorrelationIdentifiers(request = {}) {
    const outerRequestId = request.requestId || request.request_id || null;
    const payloadRequestId = request.payload?.requestId || request.payload?.request_id || null;

    return {
      requestId: outerRequestId || payloadRequestId,
      outerRequestId,
      payloadRequestId,
      clientRequestId: request.clientRequestId || request.client_request_id || request.payload?.clientRequestId || request.payload?.client_request_id || null,
      traceId: request.traceId || request.trace_id || request.payload?.traceId || request.payload?.trace_id || null,
      sequenceId: request.sequenceId || request.sequence_id || request.headers?.['x-sequence-id'] || null,
      loanApplicationId: request.loanApplicationId || request.loan_application_id || request.payload?.loanApplicationId || request.payload?.loan_application_id || null,
      lenderOrgId: request.lenderOrgId || request.lender_org_id || request.payload?.lenderOrgId || request.payload?.lender_org_id || request.payload?.themisDetail?.lenderOrgId || null,
      orderId: request.orderId || request.order_id || request.payload?.orderId || request.payload?.order_id || null
    };
  }

  extractExpectedIdentifiers(expectedEntry = {}) {
    return this.extractCorrelationIdentifiers({
      requestId: expectedEntry.requestId,
      clientRequestId: expectedEntry.clientRequestId,
      traceId: expectedEntry.traceId,
      sequenceId: expectedEntry.sequenceId,
      loanApplicationId: expectedEntry.loanApplicationId,
      lenderOrgId: expectedEntry.lenderOrgId,
      orderId: expectedEntry.orderId,
      payload: expectedEntry.payload,
      headers: expectedEntry.headers
    });
  }

  summarizeRequestForDiagnostics(request = {}) {
    const ids = this.extractCorrelationIdentifiers(request);
    return {
      logTag: request.logTag || null,
      source: request.source || null,
      destination: request.destination || null,
      sourceDestination: request.sourceDestination || null,
      requestId: ids.requestId,
      clientRequestId: ids.clientRequestId,
      traceId: ids.traceId,
      sequenceId: ids.sequenceId,
      loanApplicationId: ids.loanApplicationId,
      lenderOrgId: ids.lenderOrgId,
      orderId: ids.orderId,
      api: request.api || null
    };
  }

  summarizeExpectedForDiagnostics(expectedEntry = {}) {
    const ids = this.extractExpectedIdentifiers(expectedEntry);
    return {
      entry: expectedEntry?.toString?.() || null,
      index: expectedEntry?.index ?? null,
      logTag: expectedEntry?.logTag || null,
      source: expectedEntry?.source || null,
      destination: expectedEntry?.destination || null,
      sourceDestination: expectedEntry?.sourceDestination || null,
      requestId: ids.requestId,
      clientRequestId: ids.clientRequestId,
      traceId: ids.traceId,
      sequenceId: ids.sequenceId,
      loanApplicationId: ids.loanApplicationId,
      lenderOrgId: ids.lenderOrgId,
      orderId: ids.orderId
    };
  }

  getIncomingBufferDiagnostics(expectedEntry = null, limit = 25) {
    const expectedSummary = expectedEntry
      ? this.summarizeExpectedForDiagnostics(expectedEntry)
      : null;

    const entries = Array.from(this.incomingRequests.entries()).map(([key, entry]) => {
      const matchDetails = expectedEntry
        ? this._buildRequestMatchDetails(entry.request, expectedEntry)
        : null;

      return {
        key,
        state: entry.state,
        ageMs: Date.now() - entry.timestamp,
        claimedAgeMs: entry.claimedAt ? Date.now() - entry.claimedAt : null,
        preservedOnRewind: !!entry.preservedOnRewind,
        request: this.summarizeRequestForDiagnostics(entry.request),
        match: matchDetails
          ? {
              matches: matchDetails.matches,
              score: matchDetails.score,
              differenceCount: matchDetails.differenceCount,
              exactSignals: matchDetails.exactSignals,
              exactMatchCount: matchDetails.exactMatchCount,
              mismatchReason: matchDetails.mismatchReason || null
            }
          : null
      };
    });

    entries.sort((a, b) => {
      if (a.match && b.match && b.match.score !== a.match.score) {
        return b.match.score - a.match.score;
      }
      return b.ageMs - a.ageMs;
    });

    return {
      expected: expectedSummary,
      bufferSize: this.incomingRequests.size,
      waiterCount: this.requestWaiters.size,
      entries: entries.slice(0, limit),
      truncated: entries.length > limit
    };
  }
  
  generateKey(request) {
    const ids = this.extractCorrelationIdentifiers(request);
    const parts = [
      canonicalRequestLogTag(request.logTag),
      `${request.source}_${request.destination}`,
      ids.requestId || '',
      ids.outerRequestId && ids.payloadRequestId && ids.outerRequestId !== ids.payloadRequestId
        ? ids.payloadRequestId
        : '',
      ids.clientRequestId || '',
      ids.traceId || '',
      ids.sequenceId || '',
      ids.loanApplicationId || '',
      ids.lenderOrgId || '',
      ids.orderId || ''
    ].filter(Boolean);

    if (parts.length <= 2) {
      this.sequenceCounter += 1;
      parts.push(`seq-${this.sequenceCounter}`);
    }

    return parts.join(':');
  }
  
  async addIncomingRequest(request) {
    let key = this.generateKey(request);
    const existing = this.incomingRequests.get(key);

    logger.info('ART_BUFFER_INCOMING_ADD_ATTEMPT', {
      key,
      bufferSizeBefore: this.incomingRequests.size,
      request: this.summarizeRequestForDiagnostics(request)
    });

    if (existing && !this._isTerminalRequestState(existing.state)) {
      if (existing.preservedOnRewind) {
        key = this._buildReplayDuplicateKey(key);
      } else {
        logger.warn('Duplicate request buffered, reusing existing wait handle', {
          key,
          state: existing.state,
          requestId: request.requestId || null,
          logTag: request.logTag
        });
        return existing;
      }
    }

    if (this.incomingRequests.has(key)) {
      logger.warn('Duplicate request buffered, reusing existing wait handle', {
        key,
        state: this.incomingRequests.get(key)?.state,
        requestId: request.requestId || null,
        logTag: request.logTag
      });
      return this.incomingRequests.get(key);
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
      completedAt: null,
      preservedOnRewind: false,
      preservedAt: null
    };
    
    this.incomingRequests.set(key, entry);
    
    logger.info('ART_BUFFER_INCOMING_ADDED', {
      key,
      bufferSize: this.incomingRequests.size,
      requestId: request.requestId || null,
      logTag: request.logTag,
      source: request.source,
      destination: request.destination,
      request: this.summarizeRequestForDiagnostics(request),
      pendingWaiters: this.getPendingRequestWaiters()
    });
    
    // Notify matching waiters AFTER logging to ensure proper ordering
    this._signalWorkAvailable();
    this._notifyMatchingWaiters(entry);
    
    return entry;
  }

  async waitForMatchingRequest(expectedEntry, timeoutMs = this.config.defaultTimeoutMs) {
    const shouldPreferFreshGatewayLender = this._isGatewayLenderRequest(expectedEntry);
    logger.info('ART_BUFFER_WAIT_START', {
      expected: this.summarizeExpectedForDiagnostics(expectedEntry),
      timeoutMs,
      shouldPreferFreshGatewayLender,
      diagnostics: this.getIncomingBufferDiagnostics(expectedEntry, 15)
    });

    const claimed = this._claimOldestMatchingRequest(expectedEntry, {
      includePreserved: !shouldPreferFreshGatewayLender
    });
    if (claimed) {
      this.clearWaitDiagnostics(expectedEntry, 'immediate_buffer_match');
      logger.info('Found and claimed buffered request immediately', {
        key: claimed.key,
        expected: expectedEntry.toString()
      });
      return claimed;
    }

    const preservedFallback = this.findMatchingRequest(expectedEntry, {
      includePreserved: true,
      onlyPreserved: true,
      claim: false
    });

    // Check if there's already a waiter for this expected entry
    for (const waiter of this.requestWaiters) {
      const waiterMatchDetails = this._buildExpectedEntryMatchDetails(waiter.expectedEntry, expectedEntry);
      if (waiterMatchDetails.matches) {
        logger.warn('Duplicate waiter detected, reusing existing waiter', {
          expected: expectedEntry.toString(),
          existingWaiter: waiter.expectedEntry.toString(),
          differenceCount: waiterMatchDetails.differenceCount,
          exactSignals: waiterMatchDetails.exactSignals
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

    const shouldFastTrackPreservedFallback =
      !!preservedFallback && this._isGatewayLenderRequest(expectedEntry);
    const effectiveTimeoutMs = shouldFastTrackPreservedFallback
      ? Math.min(timeoutMs, this.config.preservedReplayFallbackWaitMs)
      : timeoutMs;

    logger.info('Waiting for buffered request match', {
      expected: expectedEntry.toString(),
      timeoutMs: effectiveTimeoutMs,
      requestedTimeoutMs: timeoutMs,
      currentBufferSize: this.incomingRequests.size,
      hasPreservedFallback: !!preservedFallback,
      waitingForFreshReplayBeforeFallback: shouldFastTrackPreservedFallback
    });

    return new Promise(resolve => {
      const waiter = {
        expectedEntry,
        resolve: entry => {
          clearTimeout(waiter.timer);
          this.requestWaiters.delete(waiter);
          if (entry) {
            this.clearWaitDiagnostics(expectedEntry, 'waiter_resolved_with_match');
          }
          logger.info('Waiter resolved', {
            expected: expectedEntry.toString(),
            found: !!entry
          });
          resolve(entry);
        }
      };

      waiter.timer = setTimeout(() => {
        this.requestWaiters.delete(waiter);

        if (preservedFallback) {
          const replayFallback = this.claimPreservedReplayRequest(preservedFallback.key, expectedEntry);
          if (replayFallback) {
            logger.info('Using preserved replay request after wait timeout', {
              key: replayFallback.key,
              expected: expectedEntry.toString()
            });
            resolve(replayFallback);
            return;
          }
        }
        
        // Enhanced logging to debug matching issues
        const bufferDiagnostics = this.getIncomingBufferDiagnostics(expectedEntry, 50);
        const bufferedRequests = bufferDiagnostics.entries.map(entry => ({
          key: entry.key,
          logTag: entry.request.logTag,
          source: entry.request.source,
          destination: entry.request.destination,
          state: entry.state,
          requestId: entry.request.requestId || null,
          match: entry.match
        }));

        this.lastMatchTimeout = {
          timestamp: new Date().toISOString(),
          expected: expectedEntry.toString(),
          expectedLogTag: expectedEntry.logTag,
          expectedSource: expectedEntry.source,
          expectedDestination: expectedEntry.destination,
          timeoutMs: effectiveTimeoutMs,
          bufferedRequests,
          bufferSize: this.incomingRequests.size,
          bufferDiagnostics
        };
        
        logger.error('ART_BUFFER_WAIT_TIMEOUT', {
          expected: expectedEntry.toString(),
          expectedLogTag: expectedEntry.logTag,
          expectedSource: expectedEntry.source,
          expectedDestination: expectedEntry.destination,
          timeoutMs: effectiveTimeoutMs,
          bufferedRequests,
          bufferSize: this.incomingRequests.size,
          bufferDiagnostics
        });
        resolve(null);
      }, effectiveTimeoutMs);

      this.requestWaiters.add(waiter);
    });
  }

  getLastMatchTimeout() {
    return this.lastMatchTimeout;
  }

  clearWaitDiagnostics(expectedEntry = null, reason = 'manual_clear') {
    const expected = expectedEntry?.toString?.() || null;

    if (this.lastMatchTimeout) {
      logger.info('Clearing buffered request wait diagnostics', {
        reason,
        expected,
        previousExpected: this.lastMatchTimeout.expected || null
      });
    }

    this.lastMatchTimeout = null;
  }

  getPendingRequestWaiters() {
    return Array.from(this.requestWaiters).map((waiter) => ({
      expected: waiter.expectedEntry?.toString?.() || null,
      logTag: waiter.expectedEntry?.logTag || null,
      source: waiter.expectedEntry?.source || null,
      destination: waiter.expectedEntry?.destination || null
    }));
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
    this._storeIncomingReplayFallback(entry);
    this.clearWaitDiagnostics(entry.request, 'incoming_request_completed');

    logger.info('ART_BUFFER_INCOMING_COMPLETED', {
      key,
      requestId: entry.request.requestId || null,
      logTag: entry.request.logTag,
      ageMs: entry.completedAt - entry.timestamp,
      request: this.summarizeRequestForDiagnostics(entry.request),
      responseStatus: response?.status || response?.payload?.status || null,
      responseSuccess: response?.success ?? null
    });

    this.incomingRequests.delete(key);

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

    this.incomingRequests.delete(key);

    return true;
  }
  
  addResponse(requestId, response, isError = false, metadata = {}) {
    if (this.responseBuffer.size >= this.config.maxBufferSize) {
      logger.error('Response buffer full, dropping response', { requestId });
      return;
    }
    
    const existing = this.responseBuffer.get(requestId);
    if (existing) {
      logger.warn('ART_BUFFER_RESPONSE_OVERWRITE', {
        requestId,
        existingMetadata: existing.metadata || {},
        newMetadata: metadata || {}
      });
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
    
    logger.info('ART_BUFFER_RESPONSE_ADDED', { 
      requestId, 
      bufferSize: this.responseBuffer.size,
      isError,
      metadata,
      response: responsePreview
    });
  }
  
  getResponseByMetadata(
    logTag,
    sourceDestination,
    loanApplicationId = null,
    lenderOrgId = null,
    clientRequestId = null,
    requestIds = [],
    orderId = null
  ) {
    const identifiers = {
      clientRequestId,
      loanApplicationId,
      lenderOrgId,
      orderId,
      requestIds: (requestIds || []).filter(Boolean)
    };
    const best = this._findBestResponseCandidate(logTag, sourceDestination, identifiers);

    if (!best) {
      return null;
    }

    this.responseBuffer.delete(best.requestId);
    this._storeResponseReplayFallback(best.requestId, best.entry);

    logger.info('Found buffered response by metadata', {
      logTag,
      sourceDestination,
      matchedSD: best.entry.metadata?.sourceDestination,
      matchedRequestId: best.requestId,
      score: best.score,
      exactMatchCount: best.exactMatchCount,
      totalCandidates: best.totalCandidates,
      requestIds: identifiers.requestIds,
      clientRequestId,
      loanApplicationId,
      lenderOrgId,
      orderId,
      usedInvertedMatch: best.entry.metadata?.sourceDestination === best.invertedSD
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

  _findBestResponseCandidate(logTag, sourceDestination, identifiers = {}) {
    const baseTag = this._normalizeLogTag(logTag);
    const invertedSD = this._invertSourceDestination(sourceDestination);
    const requestIds = (identifiers.requestIds || []).filter(Boolean);

    const candidates = [];
    for (const [requestId, entry] of this.responseBuffer) {
      const meta = entry.metadata || {};
      const metaTag = this._normalizeLogTag(meta.logTag);

      if (metaTag !== baseTag) continue;

      const metaSD = meta.sourceDestination;
      const sdMatch = metaSD === sourceDestination || metaSD === invertedSD;
      if (!sdMatch) continue;

      const exactMatches = [];
      const partialMatches = [];

      if (identifiers.clientRequestId && meta.clientRequestId === identifiers.clientRequestId) {
        exactMatches.push('clientRequestId');
      }

      if (identifiers.loanApplicationId && meta.loanApplicationId === identifiers.loanApplicationId) {
        exactMatches.push('loanApplicationId');
      }

      if (identifiers.lenderOrgId && meta.lenderOrgId === identifiers.lenderOrgId) {
        exactMatches.push('lenderOrgId');
      }

      if (identifiers.orderId && meta.orderId === identifiers.orderId) {
        exactMatches.push('orderId');
      }

      if (requestIds.length > 0) {
        if (requestIds.includes(requestId) || requestIds.includes(meta.requestId)) {
          exactMatches.push('requestId');
        } else if (meta.requestId) {
          partialMatches.push('hasRequestId');
        }
      }

      let score = metaSD === sourceDestination ? 30 : 20;
      if (exactMatches.includes('clientRequestId')) score += 80;
      if (exactMatches.includes('loanApplicationId')) score += 60;
      if (exactMatches.includes('lenderOrgId')) score += 50;
      if (exactMatches.includes('orderId')) score += 40;
      if (exactMatches.includes('requestId')) score += 35;
      if (partialMatches.includes('hasRequestId')) score += 5;

      candidates.push({
        requestId,
        entry,
        score,
        timestamp: entry.timestamp,
        exactMatches,
        exactMatchCount: exactMatches.length,
        totalCandidates: 0,
        invertedSD
      });
    }

    if (candidates.length === 0) {
      logger.debug('No response found by metadata', {
        logTag,
        sourceDestination,
        requestIds,
        clientRequestId: identifiers.clientRequestId,
        loanApplicationId: identifiers.loanApplicationId,
        lenderOrgId: identifiers.lenderOrgId,
        orderId: identifiers.orderId,
        invertedSD,
        bufferSize: this.responseBuffer.size
      });
      return null;
    }

    for (const candidate of candidates) {
      candidate.totalCandidates = candidates.length;
    }

    candidates.sort((a, b) => {
      if (b.exactMatchCount !== a.exactMatchCount) return b.exactMatchCount - a.exactMatchCount;
      if (b.score !== a.score) return b.score - a.score;
      return a.timestamp - b.timestamp;
    });

    return candidates[0];
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
      this._storeResponseReplayFallback(requestId, entry);
      return entry;
    }
    return null;
  }
  
  findMatchingRequest(expectedEntry, options = {}) {
    const {
      includePreserved = true,
      onlyPreserved = false,
      claim = true
    } = options;
    const matches = [];
    
    logger.debug('Finding matching request', {
      expected: expectedEntry.toString(),
      expectedLogTag: expectedEntry.logTag,
      expectedSource: expectedEntry.source,
      expectedDestination: expectedEntry.destination,
      bufferSize: this.incomingRequests.size
    });
    
    for (const [key, entry] of this.incomingRequests) {
      if (entry.state !== 'buffered') {
        continue;
      }

      if (onlyPreserved && !entry.preservedOnRewind) {
        continue;
      }

      if (!includePreserved && entry.preservedOnRewind) {
        continue;
      }

      const matchDetails = this._buildRequestMatchDetails(entry.request, expectedEntry);
      if (matchDetails.matches) {
        matches.push({ key, entry, matchDetails });
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

    const sequenceAlignedMatches = matches.filter(({ entry }) =>
      this._sharesSequenceContext(entry.request, expectedEntry)
    );
    const rankedMatches = sequenceAlignedMatches.length > 0 ? sequenceAlignedMatches : matches;
    const shouldUseSequenceFifo = this._shouldUseSequenceFifoForMatches(rankedMatches);

    if (sequenceAlignedMatches.length > 1) {
      logger.info(
        shouldUseSequenceFifo
          ? 'Using FIFO ordering for repeated same-context buffered requests'
          : 'Using payload-quality ordering for repeated same-context buffered requests',
        {
          expected: expectedEntry.toString(),
          candidateCount: rankedMatches.length
        }
      );
    }

    rankedMatches.sort((a, b) => {
      if (a.entry.preservedOnRewind !== b.entry.preservedOnRewind) {
        return a.entry.preservedOnRewind ? 1 : -1;
      }
      if (b.matchDetails.exactMatchCount !== a.matchDetails.exactMatchCount) {
        return b.matchDetails.exactMatchCount - a.matchDetails.exactMatchCount;
      }
      if (a.matchDetails.differenceCount !== b.matchDetails.differenceCount) {
        return a.matchDetails.differenceCount - b.matchDetails.differenceCount;
      }
      if (b.matchDetails.score !== a.matchDetails.score) {
        return b.matchDetails.score - a.matchDetails.score;
      }
      if (shouldUseSequenceFifo && a.entry.timestamp !== b.entry.timestamp) {
        return a.entry.timestamp - b.entry.timestamp;
      }
      return a.entry.timestamp - b.entry.timestamp;
    });
    const oldest = rankedMatches[0];

    if (!claim) {
      return oldest.entry;
    }

    oldest.entry.state = 'claimed';
    oldest.entry.claimedAt = Date.now();

    logger.info('Request matched', {
      key: oldest.key,
      bufferSize: this.incomingRequests.size,
      totalMatches: rankedMatches.length,
      bufferedAt: oldest.entry.timestamp,
      claimedAt: oldest.entry.claimedAt,
      waitTime: oldest.entry.claimedAt - oldest.entry.timestamp,
      expected: expectedEntry.toString(),
      matchScore: oldest.matchDetails.score,
      differenceCount: oldest.matchDetails.differenceCount,
      exactSignals: oldest.matchDetails.exactSignals,
      preservedOnRewind: !!oldest.entry.preservedOnRewind
    });

    return oldest.entry;
  }

  claimPreservedReplayRequest(key, expectedEntry) {
    const entry = this.incomingRequests.get(key);
    if (!entry || entry.state !== 'buffered' || !entry.preservedOnRewind) {
      return null;
    }

    if (!this._matchesEntry(entry.request, expectedEntry)) {
      return null;
    }

    entry.state = 'claimed';
    entry.claimedAt = Date.now();

    logger.info('Claimed preserved replay request', {
      key,
      expected: expectedEntry.toString(),
      bufferedAt: entry.timestamp,
      preservedAt: entry.preservedAt,
      claimedAt: entry.claimedAt
    });

    return entry;
  }

  hasMatchingBufferedRequest(expectedEntry) {
    for (const [, entry] of this.incomingRequests) {
      if (entry.state === 'buffered' && this._matchesEntry(entry.request, expectedEntry)) {
        return true;
      }
    }

    return false;
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
    return this._buildRequestMatchDetails(request, expectedEntry).matches;
  }

  _getRequestShapeMismatch(incoming, expected) {
    const incomingLogTag = canonicalRequestLogTag(incoming?.logTag);
    const expectedLogTag = canonicalRequestLogTag(expected?.logTag);

    if (incomingLogTag !== expectedLogTag) {
      return {
        field: 'logTag',
        incoming: incomingLogTag,
        expected: expectedLogTag
      };
    }

    if (incoming?.source !== expected?.source) {
      return {
        field: 'source',
        incoming: incoming?.source,
        expected: expected?.source
      };
    }

    if (incoming?.destination !== expected?.destination) {
      return {
        field: 'destination',
        incoming: incoming?.destination,
        expected: expected?.destination
      };
    }

    return null;
  }

  _getNestedValue(obj, path) {
    if (!obj || typeof obj !== 'object') {
      return undefined;
    }

    return path.split('.').reduce((value, key) => {
      if (value === null || value === undefined || typeof value !== 'object') {
        return undefined;
      }
      return value[key];
    }, obj);
  }

  _addPayloadSignals(expectedPayload, actualPayload, exactSignals) {
    let score = 0;

    for (const [path, weight] of PAYLOAD_SIGNAL_WEIGHTS) {
      const expectedValue = this._getNestedValue(expectedPayload, path);
      const actualValue = this._getNestedValue(actualPayload, path);

      if (expectedValue === undefined || actualValue === undefined) {
        continue;
      }

      if (expectedValue === actualValue) {
        exactSignals.push(`payload:${path}`);
        score += weight;
      } else {
        score -= weight * 2;
      }
    }

    return score;
  }

  _buildExpectedEntryMatchDetails(leftExpectedEntry, rightExpectedEntry) {
    const mismatchReason = this._getRequestShapeMismatch(leftExpectedEntry, rightExpectedEntry);
    if (mismatchReason) {
      return {
        matches: false,
        score: Number.NEGATIVE_INFINITY,
        differenceCount: Number.POSITIVE_INFINITY,
        exactSignals: [],
        exactMatchCount: 0,
        mismatchReason
      };
    }

    const exactSignals = [];
    let score = 0;
    let differenceCount = 0;

    if (leftExpectedEntry.payload && rightExpectedEntry.payload) {
      const comparison = compareLog(leftExpectedEntry.payload, rightExpectedEntry.payload, rightExpectedEntry.logTag);
      differenceCount = comparison.differenceList?.length || 0;
      score -= differenceCount;
      score += this._addPayloadSignals(leftExpectedEntry.payload, rightExpectedEntry.payload, exactSignals);
    }

    return {
      matches: differenceCount === 0 || exactSignals.length > 0,
      score,
      differenceCount,
      exactSignals,
      exactMatchCount: exactSignals.length,
      mismatchReason: null
    };
  }

  _buildRequestMatchDetails(incoming, expectedEntry) {
    const mismatchReason = this._getRequestShapeMismatch(incoming, expectedEntry);
    if (mismatchReason) {
      return {
        matches: false,
        score: Number.NEGATIVE_INFINITY,
        differenceCount: Number.POSITIVE_INFINITY,
        exactSignals: [],
        exactMatchCount: 0,
        mismatchReason
      };
    }

    const incomingIds = this.extractCorrelationIdentifiers(incoming);
    const expectedIds = this.extractExpectedIdentifiers(expectedEntry);
    const exactSignals = [];
    let score = 0;

    const exactComparisons = [
      ['requestId', 120],
      ['clientRequestId', 90],
      ['loanApplicationId', 80],
      ['lenderOrgId', 60],
      ['orderId', 50],
      ['traceId', 40]
    ];

    for (const [field, weight] of exactComparisons) {
      if (incomingIds[field] && expectedIds[field] && incomingIds[field] === expectedIds[field]) {
        exactSignals.push(field);
        score += weight;
      }
    }

    let differenceCount = 0;
    if (expectedEntry.payload && incoming.payload) {
      const comparison = compareLog(expectedEntry.payload, incoming.payload, expectedEntry.logTag);
      differenceCount = comparison.differenceList?.length || 0;
      score -= differenceCount;
      score += this._addPayloadSignals(expectedEntry.payload, incoming.payload, exactSignals);
    }

    return {
      matches: true,
      score,
      differenceCount,
      exactSignals,
      exactMatchCount: exactSignals.length,
      mismatchReason: null
    };
  }

  _sharesSequenceContext(request, expectedEntry) {
    const incomingIds = this.extractCorrelationIdentifiers(request);
    const expectedIds = this.extractExpectedIdentifiers(expectedEntry);
    const fields = ['loanApplicationId', 'lenderOrgId', 'orderId', 'clientRequestId'];
    let hasSharedContextField = false;

    for (const field of fields) {
      if (!expectedIds[field]) {
        continue;
      }

      hasSharedContextField = true;
      if (incomingIds[field] !== expectedIds[field]) {
        return false;
      }
    }

    return hasSharedContextField;
  }

  _shouldUseSequenceFifoForMatches(matches = []) {
    if (matches.length <= 1) {
      return false;
    }

    const ranked = [...matches].sort((a, b) => {
      if (a.entry.preservedOnRewind !== b.entry.preservedOnRewind) {
        return a.entry.preservedOnRewind ? 1 : -1;
      }
      if (b.matchDetails.exactMatchCount !== a.matchDetails.exactMatchCount) {
        return b.matchDetails.exactMatchCount - a.matchDetails.exactMatchCount;
      }
      if (a.matchDetails.differenceCount !== b.matchDetails.differenceCount) {
        return a.matchDetails.differenceCount - b.matchDetails.differenceCount;
      }
      if (b.matchDetails.score !== a.matchDetails.score) {
        return b.matchDetails.score - a.matchDetails.score;
      }
      return a.entry.timestamp - b.entry.timestamp;
    });

    const best = ranked[0];

    return matches.every(({ entry, matchDetails }) =>
      !!entry.preservedOnRewind === !!best.entry.preservedOnRewind &&
      matchDetails.exactMatchCount === best.matchDetails.exactMatchCount &&
      matchDetails.differenceCount === best.matchDetails.differenceCount &&
      matchDetails.score === best.matchDetails.score
    );
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
      if (entry.preservedOnRewind || this._isGatewayLenderRequest(entry.request)) {
        continue;
      }

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
      if (entry.preservedOnRewind || entry.metadata?.preservedOnRewind) {
        continue;
      }

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

  resetForReplay() {
    this._cancelAllWaiters();
    for (const [key, entry] of Array.from(this.incomingRequests.entries())) {
      this._storeIncomingReplayFallback(entry);
    }

    for (const [requestId, responseEntry] of Array.from(this.responseBuffer.entries())) {
      if (this._isGatewayLenderResponse(responseEntry)) {
        this._storeResponseReplayFallback(requestId, responseEntry);
        continue;
      }

      this.responseBuffer.delete(requestId);
    }

    this.incomingRequests.clear();
    this.responseBuffer.clear();
    this._rehydrateReplayFallbacks();

    this.pendingPromises.clear();
    this.lastMatchTimeout = null;
    this.hasWork = false;

    logger.info('Reset async buffer state for replay rewind', {
      preservedIncomingRequests: this.replayFallbackIncomingRequests.size,
      preservedResponses: this.replayFallbackResponses.size
    });
  }
  
  clear() {
    this.stop();
    this._failBufferedIncomingRequests('Buffer cleared before request completed');
    this.responseBuffer.clear();
    this.pendingPromises.clear();
    this.replayFallbackIncomingRequests.clear();
    this.replayFallbackResponses.clear();
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

  _claimOldestMatchingRequest(expectedEntry, options = {}) {
    return this.findMatchingRequest(expectedEntry, options);
  }

  _notifyMatchingWaiters(entry) {
    if (this._isTerminalRequestState(entry.state)) {
      return;
    }

    const matchingWaiters = [];
    for (const waiter of this.requestWaiters) {
      const matchDetails = this._buildRequestMatchDetails(entry.request, waiter.expectedEntry);
      logger.info('ART_BUFFER_WAITER_CANDIDATE_CHECK', {
        incomingKey: entry.key,
        incoming: this.summarizeRequestForDiagnostics(entry.request),
        expected: this.summarizeExpectedForDiagnostics(waiter.expectedEntry),
        match: {
          matches: matchDetails.matches,
          score: matchDetails.score,
          differenceCount: matchDetails.differenceCount,
          exactSignals: matchDetails.exactSignals,
          exactMatchCount: matchDetails.exactMatchCount,
          mismatchReason: matchDetails.mismatchReason || null
        }
      });
      if (!matchDetails.matches) {
        continue;
      }

      matchingWaiters.push({ waiter, matchDetails });
    }

    if (matchingWaiters.length === 0) {
      logger.warn('ART_BUFFER_NO_WAITER_MATCH_FOR_INCOMING', {
        key: entry.key,
        incoming: this.summarizeRequestForDiagnostics(entry.request),
        waiterCount: this.requestWaiters.size,
        pendingWaiters: this.getPendingRequestWaiters()
      });
      return;
    }

    matchingWaiters.sort((a, b) => {
      if (b.matchDetails.exactMatchCount !== a.matchDetails.exactMatchCount) {
        return b.matchDetails.exactMatchCount - a.matchDetails.exactMatchCount;
      }
      if (a.matchDetails.differenceCount !== b.matchDetails.differenceCount) {
        return a.matchDetails.differenceCount - b.matchDetails.differenceCount;
      }
      if (b.matchDetails.score !== a.matchDetails.score) {
        return b.matchDetails.score - a.matchDetails.score;
      }
      return 0;
    });

    const bestMatch = matchingWaiters[0];

    if (entry.state === 'buffered') {
      entry.state = 'claimed';
      entry.claimedAt = Date.now();
      
      logger.info('Request matched via notify', {
        key: entry.key,
        bufferSize: this.incomingRequests.size,
        totalMatches: matchingWaiters.length,
        bufferedAt: entry.timestamp,
        claimedAt: entry.claimedAt,
        waitTime: entry.claimedAt - entry.timestamp,
        expected: bestMatch.waiter.expectedEntry.toString(),
        matchScore: bestMatch.matchDetails.score,
        differenceCount: bestMatch.matchDetails.differenceCount,
        exactSignals: bestMatch.matchDetails.exactSignals
      });
    } else {
      logger.warn('Request already claimed, skipping notify', {
        key: entry.key,
        state: entry.state,
        expected: bestMatch.waiter.expectedEntry.toString()
      });
      return;
    }

    bestMatch.waiter.resolve(entry);
  }
}
