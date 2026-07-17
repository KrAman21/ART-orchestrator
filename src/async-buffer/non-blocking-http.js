import {
  makeRequest as blockingMakeRequest,
  normalizeHdbWebhookPayloadBeforeSend
} from '../services/http-client.js';
import { logger } from '../utils/logger.js';

export class NonBlockingHttpClient {
  constructor(bufferManager, reportGenerator = null, orderId = null, options = {}) {
    this.bufferManager = bufferManager;
    this.reportGenerator = reportGenerator;
    this.orderId = orderId;
    this.activeRequests = new Map();
    this.failedRequests = [];
    this.shouldTreatApiFailureAsExpected =
      options.shouldTreatApiFailureAsExpected || (() => false);
    this.buildFailureFallbackResponse =
      options.buildFailureFallbackResponse || (() => null);
  }
  
  async send(baseUrl, endpoint, method, payload, requestId, sourceDestination, logTag, merchantId, customHeaders = {}, logIndex = null, unixSocket = null, loanApplicationId = null, lenderOrgId = null, clientRequestId = null) {
    logger.info('Non-blocking HTTP send initiated', {
      requestId,
      logTag,
      sourceDestination,
      endpoint
    });
    
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
      logIndex,
      unixSocket
    );
    
    const normalizedPayloadForTracking = normalizeHdbWebhookPayloadBeforeSend(payload, logTag);

    this.activeRequests.set(requestId, {
      promise: requestPromise,
      timestamp: Date.now(),
      requestId,
      logTag,
      sourceDestination,
      endpoint,
      baseUrl,
      payload: normalizedPayloadForTracking,
      logIndex,
      loanApplicationId,
      lenderOrgId,
      clientRequestId
    });
    
    requestPromise.then(response => {
      const activeReq = this.activeRequests.get(requestId);
      this.activeRequests.delete(requestId);
      
      const responseBodyStr = typeof response.data === 'string' 
        ? response.data 
        : JSON.stringify(response.data);
      logger.info('HTTP_RESPONSE_RECEIVED', { 
        requestId, 
        logTag,
        endpoint,
        baseUrl,
        status: response.status,
        statusText: response.statusText,
        responseBody: responseBodyStr,
        responseBodyLength: responseBodyStr?.length || 0,
        headers: response.headers,
        error: response.error,
        message: response.message
      });
      
      const apiFailure = this.checkApiFailure(response);
      const expectedApiFailure =
        !!apiFailure && this.shouldTreatApiFailureAsExpected(activeReq, response, apiFailure);
      const hasFailure = response.error || response.status >= 500 || (!!apiFailure && !expectedApiFailure);

      if (!response.error) {
        const [source = null, destination = null] = (sourceDestination || '').split('_');
        logger.logFinalOutgoing(source, destination, endpoint, activeReq?.payload ?? payload, {
          requestId,
          logTag,
          sourceDestination,
          status: response.status,
          statusText: response.statusText,
          responseType: 'async-http-response'
        });
      }
      
      logger.info('Non-blocking request result', { 
        requestId, 
        status: response.status, 
        hasError: response.error,
        apiFailure: !!apiFailure,
        apiFailureDetails: apiFailure,
        expectedApiFailure,
        responseDataType: typeof response.data,
        willRecordFailure: hasFailure,
        hasActiveReq: !!activeReq
      });
      
      if (hasFailure) {
        const fallbackResponse = this.buildFailureFallbackResponse(activeReq, response, apiFailure, null);
        if (fallbackResponse?.response) {
          logger.warn('Non-blocking request failure tolerated via replay fallback response', {
            requestId,
            logTag,
            status: response.status,
            apiFailure,
            fallbackReason: fallbackResponse.reason || 'replay_fallback_response'
          });
          this.bufferManager.addResponse(requestId, fallbackResponse.response, false, {
            requestId,
            logTag,
            sourceDestination,
            loanApplicationId: activeReq?.loanApplicationId,
            lenderOrgId: activeReq?.lenderOrgId,
            clientRequestId: activeReq?.clientRequestId,
            orderId: this.orderId,
            toleratedFailureFallback: true,
            toleratedFailureReason: fallbackResponse.reason || null,
            postBatchConfirmationRequired: fallbackResponse.postBatchConfirmationRequired === true,
            postBatchConfirmationResponseIndex: fallbackResponse.postBatchConfirmationResponseIndex ?? null
          });
          return;
        }

        const errorMsg = apiFailure 
          ? `API returned FAILURE status: ${apiFailure.error_message || apiFailure.message || apiFailure.description || 'Unknown API error'}`
          : response.message;
        logger.error('Non-blocking request failed - recording', { 
          requestId, 
          error: errorMsg, 
          status: response.status,
          hasReportGen: !!this.reportGenerator,
          hasOrderId: !!this.orderId,
          hasActiveReq: !!activeReq
        });
        this.recordFailure(activeReq, requestId, response, null, apiFailure);
        this.bufferManager.addResponse(requestId, response, true, {
          requestId,
          logTag,
          sourceDestination,
          loanApplicationId: activeReq?.loanApplicationId,
          lenderOrgId: activeReq?.lenderOrgId,
          clientRequestId: activeReq?.clientRequestId,
          orderId: this.orderId
        });
      } else {
        logger.info('Non-blocking request completed successfully', { requestId, status: response.status });
        this.bufferManager.addResponse(requestId, response, false, {
          requestId,
          logTag,
          sourceDestination,
          loanApplicationId: activeReq?.loanApplicationId,
          lenderOrgId: activeReq?.lenderOrgId,
          clientRequestId: activeReq?.clientRequestId,
          orderId: this.orderId
        });
      }
    }).catch(error => {
      const activeReq = this.activeRequests.get(requestId);
      this.activeRequests.delete(requestId);
      logger.error('Non-blocking request exception', { requestId, error: error.message, hasActiveReq: !!activeReq });

      const fallbackResponse = this.buildFailureFallbackResponse(
        activeReq,
        { error: true, message: error.message, status: 0, data: null },
        null,
        error
      );
      if (fallbackResponse?.response) {
        logger.warn('Non-blocking request exception tolerated via replay fallback response', {
          requestId,
          logTag,
          error: error.message,
          fallbackReason: fallbackResponse.reason || 'replay_fallback_response'
        });
        this.bufferManager.addResponse(requestId, fallbackResponse.response, false, {
          requestId,
          logTag,
          sourceDestination,
          loanApplicationId: activeReq?.loanApplicationId,
          lenderOrgId: activeReq?.lenderOrgId,
          clientRequestId: activeReq?.clientRequestId,
          orderId: this.orderId,
          toleratedFailureFallback: true,
          toleratedFailureReason: fallbackResponse.reason || null,
          postBatchConfirmationRequired: fallbackResponse.postBatchConfirmationRequired === true,
          postBatchConfirmationResponseIndex: fallbackResponse.postBatchConfirmationResponseIndex ?? null
        });
        return;
      }

      this.recordFailure(activeReq, requestId, { error: true, message: error.message }, error);
      this.bufferManager.addResponse(requestId, { error: true, message: error.message }, true, {
        requestId,
        logTag,
        sourceDestination,
        loanApplicationId: activeReq?.loanApplicationId,
        lenderOrgId: activeReq?.lenderOrgId,
        clientRequestId: activeReq?.clientRequestId,
        orderId: this.orderId
      });
    });
    
    await new Promise(resolve => setImmediate(resolve));
    
    return {
      requestId,
      sent: true,
      timestamp: Date.now()
    };
  }

  recordFailure(activeReq, requestId, response, exception, apiFailure = null) {
    if (!activeReq) {
      logger.error('Cannot record failure - activeReq not provided', { requestId });
      return;
    }
    
    if (!this.reportGenerator) {
      logger.error('Cannot record failure - reportGenerator not set', { requestId });
    }
    
    if (!this.orderId) {
      logger.error('Cannot record failure - orderId not set', { requestId });
    }

    const derivedResponseError = this.extractResponseErrorDetails(response);

    const failureInfo = {
      requestId,
      logTag: activeReq.logTag,
      sourceDestination: activeReq.sourceDestination,
      endpoint: activeReq.endpoint,
      baseUrl: activeReq.baseUrl,
      requestPayload: activeReq.payload,
      error: response.error || !!apiFailure || true,
      errorMessage: apiFailure 
        ? `API FAILURE: ${apiFailure.error_message || apiFailure.message || apiFailure.description || 'Unknown API error'}`
        : (derivedResponseError.message || response.message || (exception && exception.message) || 'Unknown error'),
      errorCode: apiFailure?.error_code || apiFailure?.code || derivedResponseError.code || null,
      errorStack: exception && exception.stack,
      httpStatus: response.status,
      responseData: response.data || response,
      timestamp: new Date().toISOString()
    };

    this.failedRequests.push(failureInfo);
    logger.info('FAILURE_RECORDED', { requestId, orderId: this.orderId, logTag: activeReq.logTag });
    
    if (this.reportGenerator && this.orderId) {
      this.reportGenerator.recordFlowFailure(this.orderId, failureInfo);
      logger.info('FAILURE_SENT_TO_REPORT_GENERATOR', { requestId, orderId: this.orderId });
    }
  }
  
  checkApiFailure(response) {
    if (!response || !response.data) return null;
    
    try {
      let data = response.data;
      
      if (typeof data === 'string') {
        try {
          data = JSON.parse(data);
        } catch (e) {
          logger.debug('First JSON parse failed, trying unescape', { error: e.message });
        }
      }
      
      if (typeof data === 'string') {
        try {
          const unescaped = data.replace(/\\"/g, '"').replace(/^"|"$/g, '');
          data = JSON.parse(unescaped);
        } catch (e) {
          logger.debug('Unescape and parse failed', { error: e.message });
        }
      }
      
      const payload = data.payload || data.Payload || null;
      const status = data.status || data.Status || payload?.status || payload?.Status || null;
      logger.debug('Checking API status', { status, dataType: typeof data, hasStatus: !!status });
      
      if (status && (status === 'FAILURE' || status === 'FAILED' || status === 'ERROR')) {
        const errorInfo = data.error || data.Error || payload?.error || payload?.Error || { message: 'API returned failure status', status };
        logger.info('API failure detected', { status, error: errorInfo });
        return errorInfo;
      }
      
      return null;
    } catch (e) {
      logger.debug('checkApiFailure error', { error: e.message });
      return null;
    }
  }

  extractResponseErrorDetails(response) {
    const data = response?.data;
    if (!data) {
      return { message: null, code: null };
    }

    let parsed = data;
    if (typeof parsed === 'string') {
      try {
        parsed = JSON.parse(parsed);
      } catch {
        return { message: parsed, code: null };
      }
    }

    if (!parsed || typeof parsed !== 'object') {
      return { message: null, code: null };
    }

    return {
      message:
        parsed.error_message ||
        parsed.errorMessage ||
        parsed.description ||
        parsed.message ||
        parsed.error ||
        null,
      code:
        parsed.error_code ||
        parsed.errorCode ||
        parsed.code ||
        null
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
