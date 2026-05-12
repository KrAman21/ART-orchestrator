import { DeferredPromise } from './deferred-promise.js';
import { logger } from '../utils/logger.js';

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
  
  addResponse(requestId, response, isError = false) {
    if (this.responseBuffer.size >= this.config.maxBufferSize) {
      logger.error('Response buffer full, dropping response', { requestId });
      return;
    }
    
    this.responseBuffer.set(requestId, {
      response,
      isError,
      timestamp: Date.now()
    });
    
    this._signalWorkAvailable();
    
    logger.info('Added response to buffer', { 
      requestId, 
      bufferSize: this.responseBuffer.size,
      response: isError ? { error: response.message, status: response.statusCode } : { status: response.status, statusText: response.statusText, data: JSON.stringify(response.data).substring(0, 500) }
    });
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
    if (incoming.logTag !== expected.logTag) return false;
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
