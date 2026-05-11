import { makeRequest as blockingMakeRequest } from '../services/http-client.js';
import { logger } from '../utils/logger.js';

export class NonBlockingHttpClient {
  constructor(bufferManager) {
    this.bufferManager = bufferManager;
    this.activeRequests = new Map();
  }
  
  async send(baseUrl, endpoint, method, payload, requestId, sourceDestination, logTag, merchantId, customHeaders = {}, logIndex = null) {
    logger.info('Non-blocking HTTP send initiated', {
      requestId,
      logTag,
      sourceDestination,
      endpoint
    });
    
    // Fire the request WITHOUT awaiting - truly non-blocking
    const requestPromise = blockingMakeRequest(
      baseUrl,
      endpoint,
      method,
      payload,
      requestId,
      sourceDestination,
      logTag,
      merchantId,
      customHeaders,
      logIndex
    );
    
    this.activeRequests.set(requestId, {
      promise: requestPromise,
      timestamp: Date.now(),
      logTag,
      sourceDestination
    });
    
    // Handle completion in background - DON'T await this
    requestPromise.then(response => {
      this.activeRequests.delete(requestId);
      
      if (response.error) {
        logger.error('Non-blocking request failed', { requestId, error: response.message });
        this.bufferManager.addResponse(requestId, response, true);
      } else {
        logger.info('Non-blocking request completed', { requestId, status: response.status });
        this.bufferManager.addResponse(requestId, response, false);
      }
    }).catch(error => {
      this.activeRequests.delete(requestId);
      logger.error('Non-blocking request exception', { requestId, error: error.message });
      this.bufferManager.addResponse(requestId, { error: true, message: error.message }, true);
    });
    
    // Small delay to let the request actually start before continuing
    await new Promise(resolve => setImmediate(resolve));
    
    return {
      requestId,
      sent: true,
      timestamp: Date.now()
    };
  }
  
  async waitForResponse(requestId, timeoutMs = 30000) {
    const startTime = Date.now();
    
    while (Date.now() - startTime < timeoutMs) {
      const buffered = this.bufferManager.getResponse(requestId);
      
      if (buffered) {
        if (buffered.isError) {
          throw new Error(buffered.response.message || 'Request failed');
        }
        return buffered.response;
      }
      
      await new Promise(resolve => setTimeout(resolve, 10));
    }
    
    throw new Error(`Timeout waiting for response: ${requestId}`);
  }
  
  getActiveRequestCount() {
    return this.activeRequests.size;
  }
  
  cleanup(maxAgeMs = 300000) {
    const now = Date.now();
    const expired = [];
    
    for (const [requestId, entry] of this.activeRequests) {
      if (now - entry.timestamp > maxAgeMs) {
        expired.push(requestId);
      }
    }
    
    expired.forEach(id => this.activeRequests.delete(id));
    
    if (expired.length > 0) {
      logger.info('Cleaned up expired active requests', { count: expired.length });
    }
  }
}
