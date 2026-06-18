import { getEndpointConfig, REQUEST_TIMEOUT_OVERRIDES, SKIP_DESTINATIONS } from '../config.js';
import { transformRequest } from '../services/request-transformer.js';
import { makeRequest } from '../services/http-client.js';
import { canonicalRequestLogTag } from '../services/log-tag-normalizer.js';

/**
 * RequestForwarder - Handles request forwarding and external response management
 * 
 * Extracted from orchestrator.js, this class is responsible for:
 * - Forwarding validated requests to actual destination services
 * - Handling responses from downstream services (GW/LSP)
 * - Managing external service responses (LENDER callbacks, webhooks)
 * - Tracking pending external requests for async handling
 * 
 * Dependencies are injected via constructor for better testability and separation of concerns.
 */
export class RequestForwarder {
  /**
   * Create a RequestForwarder instance
   * @param {Object} dependencies - Dependencies object
   * @param {Object} dependencies.validator - Log sequence validator instance
   * @param {Object} dependencies.stateManager - State manager instance
   * @param {Object} dependencies.logger - Logger instance
   * @param {Object} dependencies.config - Configuration object
   * @param {Object} dependencies.callbacks - Callbacks object with handler functions
   * @param {Function} dependencies.callbacks.getContextKey - Generate context key for matching
   * @param {Function} dependencies.callbacks.findCorrespondingResponse - Find matching response entry
   * @param {Function} dependencies.callbacks.findAllCorrespondingResponses - Find all matching responses
   * @param {Function} dependencies.callbacks.comparePayloads - Compare expected and actual payloads
   * @param {Function} dependencies.callbacks.recordSuccess - Record successful step
   * @param {Function} dependencies.callbacks.recordFailure - Record failed step
   * @param {Function} dependencies.callbacks.getServiceBaseUrl - Get service base URL
   * @param {Function} dependencies.callbacks.processNextLogEntry - Process next log entry
   * @param {Function} dependencies.callbacks.triggerWebhooks - Trigger webhooks
   * @param {Function} dependencies.callbacks.trackAsyncCompletion - Track async completion
   */
  constructor({ validator, stateManager, logger, config, callbacks }) {
    this.validator = validator;
    this.stateManager = stateManager;
    this.logger = logger;
    this.config = config;
    this.callbacks = callbacks;

    // Track pending external requests (e.g., GW→LENDER) by context for out-of-order matching
    // Map<contextKey, {requestEntry, responseEntry, resolve, reject, promise, timeoutHandle}>
    this.pendingExternalRequests = new Map();

    // Buffer for early-arriving external responses (response arrives before tracking)
    // Map<contextKey, incoming>
    this.earlyExternalResponses = new Map();

    // Track webhooks to trigger after responding to external calls
    // Map<contextKey, Array> - webhooks to trigger after response is sent back
    this.pendingPostResponseWebhooks = new Map();
  }

  shouldAutoProcessNextLogEntry() {
    return this.callbacks.shouldAutoProcessNextLogEntry
      ? this.callbacks.shouldAutoProcessNextLogEntry() !== false
      : true;
  }

  shouldBlockOnHeldExternalRequest() {
    if (this.config?.asyncReplayMode) {
      return false;
    }

    return this.callbacks.shouldBlockOnHeldExternalRequest
      ? this.callbacks.shouldBlockOnHeldExternalRequest() !== false
      : true;
  }

  /**
   * Handle response from downstream service
   * This is called when we receive a response from GW/LSP after forwarding a request
   *
   * @param {Object} incomingResponse - { source, destination, api, payload, correlationId }
   * @returns {Promise<Object>} - Comparison result
   */
  async handleDownstreamResponse(incomingResponse) {
    this.logger.info('Received downstream response', {
      source: incomingResponse.source,
      destination: incomingResponse.destination,
      api: incomingResponse.api,
      correlationId: incomingResponse.correlationId
    });

    // Get next expected entry (should be a response)
    const expectedEntry = this.validator.getCurrentEntry();

    if (!expectedEntry) {
      return await this.callbacks.fail('No more entries to process - unexpected response');
    }

    // Validate this is the expected response
    const isExpectedResponse =
      expectedEntry.isResponse &&
      expectedEntry.source === incomingResponse.source &&
      expectedEntry.destination === incomingResponse.destination &&
      expectedEntry.logTag === incomingResponse.logTag;

    if (!isExpectedResponse) {
      // This might be an early response - buffer it
      this.logger.debug('Response does not match expected, buffering', {
        expected: expectedEntry.toString(),
        received: `${incomingResponse.source}→${incomingResponse.destination} ${incomingResponse.logTag}`
      });

      this.stateManager.handleIncomingResponse(
        incomingResponse.correlationId,
        incomingResponse.payload
      );

      // Return null - will be picked up when we expect this response
      return null;
    }

    // Compare payloads
    const expectedPayload = expectedEntry.payload;
    const comparison = this.callbacks.comparePayloads(expectedPayload, incomingResponse.payload, incomingResponse.logTag);

    if (!comparison.match) {
      this.logger.warn('Response comparison mismatch tolerated', {
        entry: expectedEntry.toString(),
        logTag: incomingResponse.logTag,
        differences: comparison.differences
      });
    }

    this.logger.info('Response validation passed', {
      entry: expectedEntry.toString()
    });

    // Mark entry as processed
    this.validator.advance();
    this.callbacks.recordSuccess('response_validation', expectedEntry);

    // Trigger next log entry processing (for external source requests like APP->LSP)
    if (this.shouldAutoProcessNextLogEntry()) {
      this.logger.info('Triggering processNextLogEntry after response validation');
      setImmediate(() => {
        this.logger.info('Executing setImmediate processNextLogEntry');
        this.callbacks.processNextLogEntry().catch(err => {
          this.logger.error('Error processing next log entry after response validation', { error: err.message });
        });
      });
    } else {
      this.logger.info('Skipping auto processNextLogEntry after response validation in async replay mode');
    }

    return {
      success: true,
      payload: incomingResponse.payload,
      headers: incomingResponse.headers
    };
  }

  /**
   * Forward validated request to actual destination service
   * @param {Object} incoming - Incoming request
   * @param {LogEntry} expectedEntry - Expected log entry
   */
  async forwardToDestination(incoming, expectedEntry) {
    const destination = expectedEntry.destination;
    const api = incoming.api;

    // Check if destination should be skipped (external services like LENDER, APP)
    if (SKIP_DESTINATIONS.includes(destination)) {
      this.logger.info('Skipping external destination (tracked for async response)', {
        destination,
        api,
        requestId: incoming.requestId,
        logTag: expectedEntry.logTag.replace('Request', 'Response').replace('INCOMING', 'OUTGOING'),
        sourceDestination: expectedEntry.sourceDestination
      });

      // Find the expected response from logs
      const expectedResponse = this.callbacks.findCorrespondingResponse(expectedEntry);
      if (!expectedResponse) {
        return await this.callbacks.fail(`No expected response found for skipped destination ${destination}`);
      }

      // Track this pending external request by context for out-of-order matching
      const contextKey = this.callbacks.getContextKey(expectedEntry);

      // For LENDER calls, check for webhooks that should fire BEFORE the response
      let webhooksBefore = [];
      if (destination === 'LENDER') {
        webhooksBefore = this.validator.findWebhooksForLenderCall(expectedEntry, expectedResponse, 'before');
        if (webhooksBefore.length > 0) {
          this.logger.info(`Found ${webhooksBefore.length} webhook(s) to trigger before LENDER response`, {
            requestEntry: expectedEntry.toString()
          });
          // Trigger webhooks before responding
          await this.callbacks.triggerWebhooks(webhooksBefore);
        }
      }

      // Log mocked request now. The replayed response for GATEWAY->LENDER is logged
      // only when sequence reaches the actual LENDER->GATEWAY response entry.
      this.logger.logApiCall(expectedEntry.source, expectedEntry.destination, api, 'REQUEST', expectedEntry.index);

      // For LENDER calls, check for webhooks that should fire AFTER the response (CASE 7)
      let webhooksAfter = [];
      if (destination === 'LENDER') {
        webhooksAfter = this.validator.findWebhooksAfterLenderResponse(expectedResponse, null);
        if (webhooksAfter.length > 0) {
          this.logger.info(`Found ${webhooksAfter.length} webhook(s) to trigger after LENDER response`, {
            responseEntry: expectedResponse.toString()
          });
          // Store webhooks to trigger after we send the response back to GW
          this.pendingPostResponseWebhooks.set(contextKey, webhooksAfter);
        }
      }

      if (destination === 'LENDER') {
        let resolveExternal, rejectExternal;
        const externalPromise = new Promise((resolve, reject) => {
          resolveExternal = resolve;
          rejectExternal = reject;
        });

        // Lender responses can legitimately arrive much later in the replay
        // than the original live caller would wait, especially when ART is
        // preserving prod sequencing instead of responding immediately.
        const externalTimeoutMs = Math.max(this.config.timeoutMs || 10000, 180000);
        const timeoutHandle = setTimeout(() => {
          if (this.pendingExternalRequests.has(contextKey)) {
            this.pendingExternalRequests.delete(contextKey);
            rejectExternal(new Error(
              `External request ${contextKey} timed out after ${externalTimeoutMs}ms`
            ));
          }
        }, externalTimeoutMs);

        this.pendingExternalRequests.set(contextKey, {
          requestEntry: expectedEntry,
          responseEntry: expectedResponse,
          promise: externalPromise,
          resolve: resolveExternal,
          reject: rejectExternal,
          timeoutHandle
        });

        const earlyResponse = this.earlyExternalResponses.get(contextKey);
        if (earlyResponse) {
          this.logger.info('Processing early-arrived response now', { contextKey });
          this.earlyExternalResponses.delete(contextKey);
          this.handleExternalServiceResponse(earlyResponse).catch(err => {
            this.logger.error('Error processing early response', { error: err.message });
          });
        }

        this.logger.debug('Tracked pending external request', {
          contextKey,
          requestIndex: expectedEntry.index,
          expectedResponseIndex: expectedResponse.index
        });

        this.logger.info('Holding GATEWAY->LENDER request until replay reaches actual response entry', {
          contextKey,
          requestEntry: expectedEntry.toString(),
          responseEntry: expectedResponse.toString()
        });

        const shouldBlockHeldRequest = this.shouldBlockOnHeldExternalRequest();

        this.logger.info('Evaluated held GATEWAY->LENDER request blocking mode', {
          contextKey,
          asyncReplayMode: this.config?.asyncReplayMode === true,
          shouldBlockHeldRequest
        });

        if (!shouldBlockHeldRequest) {
          this.logger.info('Not blocking on held GATEWAY->LENDER request in async replay mode', {
            contextKey,
            requestEntry: expectedEntry.toString(),
            responseEntry: expectedResponse.toString()
          });
          return {
            success: true,
            payload: transformRequest(expectedResponse.payload, expectedResponse.logTag),
            tracked: true,
            externalSkipped: true,
            deferredExternalResponse: true
          };
        }

        const replayedResponse = await externalPromise;
        return {
          ...replayedResponse,
          tracked: true,
          externalSkipped: true
        };
      }

      // Only track external call if there are webhooks to wait for
      const totalWebhooks = webhooksBefore.length + webhooksAfter.length;
      if (totalWebhooks > 0) {
        // Create a promise that will resolve when the external response arrives
        let resolveExternal, rejectExternal;
        const externalPromise = new Promise((resolve, reject) => {
          resolveExternal = resolve;
          rejectExternal = reject;
        });

        // Set a timeout for the external response (default 30s)
        const externalTimeoutMs = this.config.timeoutMs || 10000;
        const timeoutHandle = setTimeout(() => {
          if (this.pendingExternalRequests.has(contextKey)) {
            this.pendingExternalRequests.delete(contextKey);
            rejectExternal(new Error(
              `External request ${contextKey} timed out after ${externalTimeoutMs}ms`
            ));
          }
        }, externalTimeoutMs);

        this.pendingExternalRequests.set(contextKey, {
          requestEntry: expectedEntry,
          responseEntry: expectedResponse,
          promise: externalPromise,
          resolve: resolveExternal,
          reject: rejectExternal,
          timeoutHandle
        });

        // Check if response arrived early and process it now
        const earlyResponse = this.earlyExternalResponses.get(contextKey);
        if (earlyResponse) {
          this.logger.info('Processing early-arrived response now', { contextKey });
          this.earlyExternalResponses.delete(contextKey);
          // Process immediately (but don't return - continue with normal response)
          this.handleExternalServiceResponse(earlyResponse).catch(err => {
            this.logger.error('Error processing early response', { error: err.message });
          });
        }

        this.logger.debug('Tracked pending external request', {
          contextKey,
          requestIndex: expectedEntry.index,
          expectedResponseIndex: expectedResponse.index
        });

        // Track this external call so we can wait for it before returning response to caller
        this.logger.info('Tracking external call for later wait', {
          contextKey,
          source: incoming.source,
          destination: incoming.destination
        });

        // Return marker so caller knows to wait for all pending external calls
        return {
          success: true,
          payload: transformRequest(expectedResponse.payload, expectedResponse.logTag),
          tracked: true,
          externalSkipped: true
        };
      }

      // No webhooks expected - mark entries as processed and return immediately
      this.logger.info('No webhooks expected for external call, completing immediately', {
        contextKey,
        destination
      });

      // Mark entries as processed
      // NOTE: advance() for the request was already called in handleIncomingRequest (orchestrator.js:516)
      // before forwardToDestination is invoked. Calling it again here would skip the NEXT unrelated
      // entry in the sequence (e.g., an APP_WRAPPER polling request interleaved between LENDER request/response).
      this.validator.markProcessed(expectedResponse); // response

      // Track async completion for count-based handling
      // For async parallel calls, use orderId as context key to match the tracker
      const asyncContextKey = expectedEntry.orderId || contextKey;
      const isComplete = this.callbacks.trackAsyncCompletion(asyncContextKey, expectedEntry);

      // Return success immediately without tracking/waiting
      return {
        success: true,
        payload: transformRequest(expectedResponse.payload, expectedResponse.logTag),
        tracked: false,
        externalSkipped: false,
        asyncComplete: isComplete
      };
    }

    this.logger.info('Forwarding to destination', {
      destination,
      api,
      requestId: incoming.requestId
    });
    this.logger.logOutgoing(incoming.source, incoming.destination, api, incoming.payload, {
      requestId: incoming.requestId,
      logTag: expectedEntry.logTag,
      sourceDestination: expectedEntry.sourceDestination,
      logIndex: expectedEntry.index
    });
    this.logger.info('Service invoked', {
      destination,
      api,
      requestId: incoming.requestId,
      logTag: expectedEntry.logTag
    });

    // Get endpoint config for custom headers
    const endpointConfig = getEndpointConfig(expectedEntry.sourceDestination, expectedEntry.logTag);
    const customHeaders = { ...incoming.headers, ...endpointConfig?.headers };

    // Log incoming request headers from LSP
    this.logger.info('=== INCOMING REQ HEADERS (from LSP) ===', {
      source: incoming.source,
      destination: incoming.destination,
      api: incoming.api,
      incomingHeaders: incoming.headers,
      timestamp: new Date().toISOString()
    });

    try {
      // Get endpoint from config - use mapped endpoint instead of incoming api
      const endpointConfig = getEndpointConfig(expectedEntry.sourceDestination, expectedEntry.logTag);
      const endpoint = endpointConfig?.endpoint || api;
      
      this.logger.info('Resolved endpoint for forwarding', {
        incomingApi: api,
        mappedEndpoint: endpoint,
        sourceDestination: expectedEntry.sourceDestination,
        logTag: expectedEntry.logTag
      });

      // Generate correlation key for tracking
      const correlationKey = this.stateManager.constructor.generateCorrelationKey(
        endpoint,
        expectedEntry.sourceDestination,
        incoming.requestId
      );

      // Find the expected response entry (may not be the immediate next entry)
      let expectedResponse = this.callbacks.findCorrespondingResponse(expectedEntry);
      
      // Fallback: positional matching when strict correlation fails (e.g., FetchOfferRequest)
      if (!expectedResponse) {
        const baseTag = (tag) => (tag || '').replace(/_REQUEST$/i, '').replace(/_RESPONSE$/i, '');
        const nextResponse = this.validator.entries.find(e =>
          e.index > expectedEntry.index &&
          e.isResponse &&
          baseTag(e.logTag) === baseTag(expectedEntry.logTag)
        );
        if (nextResponse) {
          this.logger.info('Positional fallback: found next response by logTag', {
            request: expectedEntry.toString(),
            response: nextResponse.toString()
          });
          expectedResponse = nextResponse;
        }
      }
      
      this.logger.info('Found expected response for request', {
        request: expectedEntry.toString(),
        expectedResponse: expectedResponse ? expectedResponse.toString() : 'null'
      });

      // Register pending request (for response matching)
      const responsePromise = this.stateManager.registerPendingRequest(
        correlationKey,
        expectedResponse
      );

      // Use original source_destination for makeRequest to detect WRAPPER correctly
      const sourceDestinationForRequest = expectedEntry.originalSourceDestination || expectedEntry.sourceDestination;

      // Transform masked values in payload before forwarding
      const transformedPayload = transformRequest(incoming.payload, expectedEntry.logTag);
      const requestTimeoutMs =
        REQUEST_TIMEOUT_OVERRIDES[expectedEntry.logTag] ||
        this.config.timeoutMs ||
        10000;

      // Make actual HTTP request to destination
      const serviceResponse = await makeRequest(
        this.callbacks.getServiceBaseUrl(destination),
        endpoint,
        'POST',
        transformedPayload,
        incoming.requestId,
        sourceDestinationForRequest,
        expectedEntry.logTag,
        null,
        customHeaders,
        expectedEntry.index,
        this.callbacks.getServiceUnixSocket(endpointConfig?.service || destination),
        requestTimeoutMs
      );

      this.logger.info('Response received from service', {
        destination,
        api: endpoint,
        requestId: incoming.requestId,
        logTag: expectedEntry.logTag,
        status: serviceResponse?.status || null,
        hasError: !!serviceResponse?.error
      });

      const apiFailure = this.checkApiFailure(serviceResponse);

      if (serviceResponse && (serviceResponse.error || serviceResponse.status !== 200 || apiFailure)) {
        let errorMsg;
        if (apiFailure) {
          errorMsg = `API returned FAILURE status: ${apiFailure.error_message || apiFailure.message || apiFailure.description || 'Unknown API error'}`;
        } else if (serviceResponse.error) {
          errorMsg = `HTTP request failed: ${serviceResponse.message}`;
        } else {
          errorMsg = `LSP call failed with status ${serviceResponse.status}: ${serviceResponse.statusText}`;
        }
        
        this.logger.error('=== LSP CALL FAILED - STOPPING ===', {
          url: `${this.callbacks.getServiceBaseUrl(destination)}${endpoint}`,
          status: serviceResponse.status,
          statusText: serviceResponse.statusText,
          error: serviceResponse.error,
          apiFailure: !!apiFailure,
          message: serviceResponse.message,
          responseData: serviceResponse.data,
          requestId: incoming.requestId,
          logTag: expectedEntry.logTag,
          destination
        });

        if (this.callbacks.recordBufferFailure) {
          this.callbacks.recordBufferFailure({
            requestId: incoming.requestId,
            logTag: expectedEntry.logTag,
            sourceDestination: expectedEntry.sourceDestination,
            endpoint: endpoint,
            baseUrl: this.callbacks.getServiceBaseUrl(destination),
            requestPayload: transformedPayload,
            error: serviceResponse.error || !!apiFailure || true,
            errorMessage: apiFailure 
              ? `API FAILURE: ${apiFailure.error_message || apiFailure.message || apiFailure.description || 'Unknown API error'}`
              : (serviceResponse.message || errorMsg),
            errorCode: apiFailure?.error_code || apiFailure?.code || null,
            errorStack: null,
            httpStatus: serviceResponse.status,
            responseData: serviceResponse.data
          });
        }

        try {
          const { execSync } = require('child_process');
          const eulerLspLog = execSync(
            'tail -50 /home/kumar-aman/Desktop/repos/euler-lsp/logs/euler-lsp.log 2>/dev/null || echo "Could not read euler-lsp logs"',
            { encoding: 'utf-8', timeout: 5000 }
          );
          this.logger.error('=== EULER-LSP LOGS (last 50 lines) ===', {
            logs: eulerLspLog.split('\n').slice(-20)
          });
        } catch (e) {
          this.logger.error('Could not read euler-lsp logs', { error: e.message });
        }

        throw new Error(errorMsg);
      }

      // If response came synchronously, handle it
      if (serviceResponse && !serviceResponse.error) {
        // Store response headers for forwarding
        if (serviceResponse.headers) {
          this.stateManager.storeResponseHeaders(correlationKey, serviceResponse.headers);
        }

        // Validate response against expected
        if (expectedResponse) {
          const comparison = this.callbacks.comparePayloads(
            expectedResponse.payload,
            serviceResponse.data,
            expectedResponse.logTag
          );

          if (!comparison.match) {
            this.logger.warn('Downstream response mismatch tolerated', {
              request: expectedEntry.toString(),
              response: expectedResponse.toString(),
              differences: comparison.differences
            });
          } else {
            this.logger.info('Downstream response validated', {
              request: expectedEntry.toString(),
              response: expectedResponse.toString()
            });
            this.callbacks.recordSuccess('downstream_response_validation', expectedResponse);
          }

          // Mark response as processed
          this.validator.markProcessed(expectedResponse);
        }

        // Log API response
        if (expectedResponse) {
          this.logger.logApiCall(expectedResponse.source, expectedResponse.destination, api, 'RESPONSE', expectedResponse.index);
        }

        // Try to match with pending
        const handled = this.stateManager.handleIncomingResponse(
          correlationKey,
          serviceResponse.data
        );

        if (handled) {
          // Response was matched with pending request - include headers
          // Trigger next log entry processing for external source requests
          if (this.shouldAutoProcessNextLogEntry()) {
            this.logger.info('Triggering processNextLogEntry after sync downstream response');
            setImmediate(() => {
              this.callbacks.processNextLogEntry().catch(err => {
                this.logger.error('Error processing next log entry after sync response', { error: err.message });
              });
            });
          } else {
            this.logger.info('Skipping auto processNextLogEntry after sync downstream response in async replay mode');
          }
          return {
            success: true,
            payload: serviceResponse.data,
            headers: serviceResponse.headers
          };
        }
      }

      // Wait for response (handles race condition where response arrives separately)
      const finalResponse = await responsePromise;

      // Log API response for async case
      if (expectedResponse) {
        this.logger.logApiCall(expectedResponse.source, expectedResponse.destination, api, 'RESPONSE', expectedResponse.index);
      }

      // Get stored headers and include in response
      const storedHeaders = this.stateManager.getResponseHeaders(correlationKey);

      // Validate and mark expected response as processed if not already done
      if (expectedResponse && !this.validator.processedIndices.has(expectedResponse.index)) {
        this.validator.markProcessed(expectedResponse);
        this.callbacks.recordSuccess('downstream_response_validation', expectedResponse);
      }

      // Trigger next log entry processing for external source requests
      if (this.shouldAutoProcessNextLogEntry()) {
        this.logger.info('Triggering processNextLogEntry after async downstream response');
        setImmediate(() => {
          this.callbacks.processNextLogEntry().catch(err => {
            this.logger.error('Error processing next log entry after async response', { error: err.message });
          });
        });
      } else {
        this.logger.info('Skipping auto processNextLogEntry after async downstream response in async replay mode');
      }

      return {
        ...finalResponse,
        headers: finalResponse.headers || storedHeaders
      };

    } catch (error) {
      this.logger.error('Error forwarding request to destination', {
        destination,
        api,
        error: error.message
      });
      return await this.callbacks.fail(`Forwarding failed for ${destination} ${api}: ${error.message}`, {
        destination,
        api,
        requestId: incoming.requestId,
        expectedEntry: expectedEntry?.toString?.()
      });
    }
  }

  /**
   * Handle response from an external service (e.g., LENDER→GW callback)
   * Matches by context (loan_application_id, lender_org_id) to find the corresponding request
   * @param {Object} incoming - Incoming response from external service
   */
  async handleExternalServiceResponse(incoming) {
    // Build context key from incoming response payload
    const incomingLoanAppId = incoming.payload?.loan_application_id || incoming.payload?.applicationid;
    const incomingLenderOrgId = incoming.payload?.lender_org_id;
    const contextKey = [incomingLoanAppId, incomingLenderOrgId].filter(Boolean).join(':');

    this.logger.info('Handling external service response', {
      source: incoming.source,
      destination: incoming.destination,
      contextKey,
      pendingCount: this.pendingExternalRequests.size
    });

    // Find matching pending request by context
    let matchedEntry = null;
    let matchedResponse = null;
    let pendingInfo = null;

    for (const [key, value] of this.pendingExternalRequests.entries()) {
      const responseContextKey = this.callbacks.getContextKey(value.responseEntry);
      if (responseContextKey === contextKey || key === contextKey) {
        matchedEntry = value.requestEntry;
        matchedResponse = value.responseEntry;
        pendingInfo = value;
        this.pendingExternalRequests.delete(key);
        this.logger.info('Matched external response to pending request', {
          requestIndex: matchedEntry.index,
          responseIndex: matchedResponse.index,
          contextKey
        });
        break;
      }
    }

    // If no match, check if response arrived early (before we tracked the request)
    if (!matchedResponse) {
      this.logger.warn('No pending external request found for response, buffering', {
        contextKey,
        availableKeys: Array.from(this.pendingExternalRequests.keys())
      });
      this.earlyExternalResponses.set(contextKey, incoming);
      return {
        success: true,
        buffered: true,
        message: 'Response buffered, awaiting matching request'
      };
    }

    // Compare the incoming response with expected
    const comparison = this.callbacks.comparePayloads(
      matchedResponse.payload,
      incoming.payload,
      incoming.logTag || matchedResponse.logTag
    );

    if (!comparison.match) {
      this.logger.warn('External response comparison mismatch tolerated', {
        request: matchedEntry.toString(),
        response: matchedResponse.toString(),
        logTag: incoming.logTag || matchedResponse.logTag,
        differences: comparison.differences
      });
    }

    // Mark both request and response as processed in the validator
    // First mark the request entry as processed
    if (matchedEntry.index < this.validator.currentIndex) {
      // Already passed - no need to mark
      this.logger.debug('Request entry already passed', { index: matchedEntry.index });
    } else if (matchedEntry.index === this.validator.currentIndex) {
      // Currently at this entry - advance
      this.validator.advance();
    } else {
      // Ahead of current - mark as processed without advancing through intervening entries
      this.validator.markProcessed(matchedEntry);
    }

    // Mark the response as processed (it's after the request)
    this.validator.markProcessed(matchedResponse);
    this.callbacks.recordSuccess('external_response_matched', matchedResponse);

    // Resolve the pending promise so any waiting callers can proceed
    if (pendingInfo) {
      clearTimeout(pendingInfo.timeoutHandle);
      pendingInfo.resolve({
        success: true,
        payload: matchedResponse.payload
      });
    }

    // Note: processNextLogEntry is NOT called here.
    // The main flow (handleIncomingRequest) waits for all external calls via waitForAllExternalCalls
    // and then triggers processNextLogEntry after returning the response.

    return {
      success: true,
      payload: matchedResponse.payload
    };
  }

  /**
   * Handle retried requests from services that didn't receive a response in time.
   * When a service retries a request we already processed (like GW→LENDER),
   * return the cached mock response instead of failing.
   *
   * @param {Object} incoming - The incoming request
   * @returns {Object|null} - Response if handled as retry, null otherwise
   */
  handleRetryRequest(incoming) {
    this.logger.info('handleRetryRequest called', {
      incomingSource: incoming.source,
      incomingDest: incoming.destination,
      incomingLogTag: incoming.logTag,
      incomingLenderOrgId: incoming.lenderOrgId,
      incomingRequestId: incoming.requestId,
      pendingCount: this.pendingExternalRequests.size
    });

    // Check if this request matches an already-processed log entry
    // Look for entries that were skipped (external destinations like LENDER)
    for (const [contextKey, pendingInfo] of this.pendingExternalRequests.entries()) {
      const requestEntry = pendingInfo.requestEntry;

      // Check if this incoming request matches the pending request entry
      if (
        requestEntry.source === incoming.source &&
        requestEntry.destination === incoming.destination &&
        requestEntry.logTag === incoming.logTag
      ) {
        // Check context match (loan_application_id, lender_org_id)
        let contextMatches = true;
        if (incoming.loanApplicationId && requestEntry.loanApplicationId) {
          contextMatches = incoming.loanApplicationId === requestEntry.loanApplicationId;
        }
        if (incoming.lenderOrgId && requestEntry.lenderOrgId) {
          contextMatches = contextMatches && incoming.lenderOrgId === requestEntry.lenderOrgId;
        }

        if (contextMatches) {
          // This is a retry - return the cached response
          this.logger.info('Detected retry request, returning cached response', {
            contextKey,
            requestIndex: requestEntry.index,
            responseIndex: pendingInfo.responseEntry.index
          });

          return {
            success: true,
            payload: transformRequest(pendingInfo.responseEntry.payload, pendingInfo.responseEntry.logTag),
            retry: true
          };
        }
      }
    }

    return null;
  }

  /**
   * Check if there are pending external requests
   * @returns {boolean} Whether there are pending requests
   */
  hasPendingExternalRequests() {
    return this.pendingExternalRequests.size > 0;
  }

  /**
   * Get count of pending external requests
   * @returns {number} Number of pending requests
   */
  getPendingExternalRequestCount() {
    return this.pendingExternalRequests.size;
  }

  /**
   * Clear all pending external request state
   */
  clearPendingState() {
    // Clear any remaining timeout handles
    for (const [key, pendingInfo] of this.pendingExternalRequests.entries()) {
      if (pendingInfo.timeoutHandle) {
        clearTimeout(pendingInfo.timeoutHandle);
      }
    }
    this.pendingExternalRequests.clear();
    this.earlyExternalResponses.clear();
    this.pendingPostResponseWebhooks.clear();
  }
  
  checkApiFailure(response) {
    if (!response || !response.data) return null;
    
    try {
      let data = response.data;
      if (typeof data === 'string') {
        data = JSON.parse(data);
      }
      
      const payload = data.payload || data.Payload || null;
      const status = data.status || data.Status || payload?.status || payload?.Status || null;
      if (status && (status === 'FAILURE' || status === 'FAILED' || status === 'ERROR')) {
        return data.error || data.Error || payload?.error || payload?.Error || { message: 'API returned failure status', status };
      }
      
      return null;
    } catch (e) {
      return null;
    }
  }
}

export default RequestForwarder;
