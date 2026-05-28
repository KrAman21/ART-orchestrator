import { DeferredPromise } from './deferred-promise.js';
import { logger } from '../utils/logger.js';
import { canonicalRequestLogTag } from '../services/log-tag-normalizer.js';

export class BufferManager {
  constructor(config = {}) {
    this.incomingRequests = new Map();
    this.responseBuffer = new Map();
    this.pendingPromises = new Map();
    
    this.config = {
      maxBufferSize: 1000,
      defaultTimeoutMs: 60000,
      ...config
    };
    
    this.workCallbacks = [];
    this.hasWork = false;
    
    this._startCleanupTimer();
  }
  
  _startCleanupTimer() {
    setInterval(() => {
      this._cleanupExpiredEntries();
    }, this.config.cleanupIntervalMs);
  }
  
  generateKey(request) {
    const parts = [
      request.logTag,
      `${request.source}_${request.destination}`,
      request.requestId || '',
      request.loanApplicationId || '',
      request.lenderOrgId || ''
    ];
    return parts.filter(Boolean).join(':');
  }
  
  async addIncomingRequest(request) {
    if (this.incomingRequests.size >= this.config.maxBufferSize) {
      throw new Error('Incoming request buffer full');
    }
    
    const key = this.generateKey(request);
    const deferred = new DeferredPromise(this.config.defaultTimeoutMs);
    
    const entry = {
      request,
      deferred,
      timestamp: Date.now(),
      key
    };
    
    this.incomingRequests.set(key, entry);
    this._signalWorkAvailable();
    
    logger.info('Buffered incoming request', { key, bufferSize: this.incomingRequests.size });
    
    return entry;
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
  
  getResponseByMetadata(logTag, sourceDestination, loanApplicationId = null) {
    const baseTag = (tag) => (tag || '').replace(/_REQUEST$/i, '').replace(/_RESPONSE$/i, '').replace(/_OUTGOING$/i, '').replace(/_INCOMING$/i, '');
    
    const matches = [];
    for (const [requestId, entry] of this.responseBuffer) {
      const meta = entry.metadata || {};
      if (baseTag(meta.logTag) === baseTag(logTag) && meta.sourceDestination === sourceDestination) {
        matches.push({ requestId, entry });
      }
    }
    
    if (matches.length === 0) {
      logger.debug('No response found by metadata', { logTag, sourceDestination, loanApplicationId, bufferSize: this.responseBuffer.size });
      return null;
    }
    
    // Sort by timestamp (oldest first)
    matches.sort((a, b) => a.entry.timestamp - b.entry.timestamp);
    
    // If loanApplicationId provided, prefer exact match
    if (loanApplicationId) {
      const matchingLoanApp = matches.find(m => m.entry.metadata?.loanApplicationId === loanApplicationId);
      if (matchingLoanApp) {
        this.responseBuffer.delete(matchingLoanApp.requestId);
        logger.info('Found buffered response by metadata (loanApplicationId match)', {
          logTag,
          sourceDestination,
          loanApplicationId,
          matchedRequestId: matchingLoanApp.requestId
        });
        return matchingLoanApp.entry;
      }
    }
    
    // Return oldest matching
    const oldest = matches[0];
    this.responseBuffer.delete(oldest.requestId);
    logger.info('Found buffered response by metadata (oldest match)', {
      logTag,
      sourceDestination,
      loanApplicationId,
      matchedRequestId: oldest.requestId,
      totalMatches: matches.length
    });
    return oldest.entry;
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
    for (const [key, entry] of this.incomingRequests) {
      if (this._matchesEntry(entry.request, expectedEntry)) {
        matches.push({ key, entry });
      }
    }
    
    if (matches.length === 0) {
      return null;
    }
    
    matches.sort((a, b) => a.entry.timestamp - b.entry.timestamp);
    const oldest = matches[0];
    
    this.incomingRequests.delete(oldest.key);
    
    logger.info('Found matching buffered request (oldest first)', {
      key: oldest.key,
      bufferSize: this.incomingRequests.size,
      totalMatches: matches.length,
      timestamp: oldest.entry.timestamp
    });
    
    return oldest.entry;
  }
  
  _matchesRequest(incoming, expected) {
    if (canonicalRequestLogTag(incoming.logTag) !== canonicalRequestLogTag(expected.logTag)) return false;
    if (incoming.source !== expected.source) return false;
    if (incoming.destination !== expected.destination) return false;
    
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
      if (now - entry.timestamp > this.config.defaultTimeoutMs) {
        expired.push(key);
      }
    }
    
    expired.forEach(key => {
      const entry = this.incomingRequests.get(key);
      if (entry) {
        entry.deferred.reject(new Error('Request expired in buffer'));
        this.incomingRequests.delete(key);
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
    this.incomingRequests.clear();
    this.responseBuffer.clear();
    this.pendingPromises.clear();
  }
}
