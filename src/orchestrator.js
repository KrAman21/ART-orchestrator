import { StateManager } from './services/state-manager.js';
import { LogSequenceValidator, LogEntry } from './services/log-sequence-validator.js';
import { makeRequest, triggerWebhook } from './services/http-client.js';
import { compareLog } from './services/comparator.js';
import { logger } from './utils/logger.js';
import { extractPayload, getApiForLogTag as getApiFromConfig, getEndpointConfig, SERVICE_MAP, SKIP_DESTINATIONS, isAsyncParallelApi } from './config.js';

/**
 * ReplayOrchestrator - Event-driven orchestrator for replaying production logs
 *
 * Architecture:
 * - Receives incoming requests from LSP and GW
 * - Validates against expected log sequence
 * - Forwards to actual destination services
 * - Handles responses and race conditions
 */
export class ReplayOrchestrator {
  constructor(logs, config = {}) {
    this.logs = logs;
    this.config = {
      timeoutMs: 10000,
      ...config
    };

    // Initialize core components
    this.stateManager = new StateManager({
      defaultTimeoutMs: this.config.timeoutMs
    });
    this.validator = new LogSequenceValidator(logs);

    // Results tracking
    this.results = {
      passed: 0,
      failed: 0,
      errors: [],
      processedLogs: []
    };

    // Track pending external requests (e.g., GW→LENDER) by context for out-of-order matching
    // Map<contextKey, {requestEntry, responseEntry, resolve, reject, promise}>
    this.pendingExternalRequests = new Map();

    // Buffer for early-arriving external responses (response arrives before tracking)
    // Map<contextKey, incoming>
    this.earlyExternalResponses = new Map();

    // Track which external calls were triggered by which incoming request
    // Map<requestId, Set<contextKey>> - tracks external calls per parent request
    this.requestToExternalCalls = new Map();

    // Track which webhooks have been triggered to avoid duplicates
    this.triggeredWebhooks = new Set();

    // Count-based async tracking for out-of-order processing
    // Map<contextKey, { expected: number, actual: number, entries: Set<index> }>
    this.asyncCallTracker = new Map();

    this.isRunning = false;
  }

  /**
   * Generate a context key for matching requests and responses
   * Based on loan_application_id, lender_org_id, or order_id
   */
  getContextKey(entry) {
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
   * Extract merchantId from logs
   * Throws error if not found
   */
  static extractMerchantId(logs) {
    for (const log of logs) {
      const merchantId = log?.message?.merchant_id;
      const orderId = log?.message?.order_id;
      if (merchantId && orderId) {
        logger.info('Extracted merchantId and orderId from logs', { merchantId, orderId });
        return {merchantId, orderId};
      }
    }
    throw new Error('merchant_id not found in logs. Seed data onboarding requires merchant_id.');
  }

  /**
   * Onboard seed data to LSP
   * Called before replay starts
   */
  async onboardSeedData(merchantId) {
    logger.info('Onboarding seed data to LSP: ', { baseUrl: SERVICE_MAP.LSP.baseUrl + '/art/configs/set', merchantId });

    try {
      const response = await makeRequest(
        SERVICE_MAP.LSP.baseUrl,
        '/art/configs/set',
        'POST',
        { merchantId },
        null,  // requestId
        null,  // sourceDestination
        null,  // logTag
        merchantId
      );

      if (response.error) {
        throw new Error(`Seed data onboarding failed: ${response.message}`);
      }

      if (response.status !== 200) {
        throw new Error(`Seed data onboarding failed: HTTP ${response.status}`);
      }

      logger.info('Seed data onboarding successful', {
        merchantId,
        status: response.status
      });

    } catch (error) {
      logger.error('Seed data onboarding failed', { merchantId, error: error.message });
      throw error;
    }
  }

  /**
   * Start the replay session
   */
  async start() {
    this.isRunning = true;

    // Extract merchantId and onboard seed data
    const { merchantId, orderId} = ReplayOrchestrator.extractMerchantId(this.logs);

    // Clear LSP data when journey completes successfully
    await this.clearLspData(merchantId, orderId);
    // Set Onboarding data for the merchant to ensure LSP is ready for the replay session
    await this.onboardSeedData(merchantId);

    logger.info('Replay orchestrator started', {
      totalLogs: this.logs.length,
      validator: this.validator.getProgress()
    });

    // Begin processing - trigger first external request if needed
    await this.processNextLogEntry();
  }

  /**
   * Process log entries sequentially, triggering external source requests
   */
  async processNextLogEntry() {
    if (!this.isRunning) return;

    const entry = this.validator.getCurrentEntry();

    logger.info('processNextLogEntry called', {
      currentEntry: entry ? entry.toString() : 'none',
      isExternalSource: entry?.isExternalSource(),
      isRequest: entry?.isRequest
    });

    if (!entry) {
      logger.info('No more log entries to process');
      return;
    }

    // If source is external (APP, LENDER), orchestrator needs to trigger the request
    if (entry.isExternalSource() && entry.isRequest) {
      logger.info('External source request - triggering from orchestrator', {
        entry: entry.toString()
      });

      await this.triggerExternalRequest(entry);
    } else {
      logger.debug('Not an external source request, waiting for incoming', {
        entry: entry.toString()
      });
    }
    // Otherwise, wait for incoming request (normal flow)
  }

  /**
   * Trigger a request from external source (APP/LENDER) to internal service
   */
  async triggerExternalRequest(entry) {
    try {
      const service = entry.destination;
      let api;

      // For LENDER->GW webhooks, use the endpoint from API_TO_ENDPOINT_MAP
      if (entry.isLenderToGwWebhook && entry.isLenderToGwWebhook()) {
        const webhookConfig = getEndpointConfig('LENDER_GW', 'WEBHOOK Request');
        api = webhookConfig?.endpoint || '/gateway/webhook';
        if (entry.lenderOrgId) {
          api = `${api}/${entry.lenderOrgId}`;
        }
      } else {
        api = this.getApiForLogTag(entry.logTag);
      }

      // Get expected response for comparison later
      // Match by source/destination direction and correlation fields if present
      const expectedResponse = this.validator.peekNext(100).find(e => {
        // Basic direction match
        if (!(e.source === entry.destination &&
          e.destination === entry.source &&
          e.isResponse)) {
          return false;
        }

        // If request has loan_application_id, response must match
        if (entry.loanApplicationId &&
          e.loanApplicationId !== entry.loanApplicationId) {
          return false;
        }

        // If request has lender_org_id, response must match
        if (entry.lenderOrgId && e.lenderOrgId !== entry.lenderOrgId) {
          return false;
        }

        return true;
      });

      // Get endpoint config for custom headers
      const endpointConfig = getEndpointConfig(entry.sourceDestination, entry.logTag);
      const customHeaders = endpointConfig?.headers || {};

      // Use original source_destination for makeRequest to detect WRAPPER correctly
      const sourceDestinationForRequest = entry.originalSourceDestination || entry.sourceDestination;

      // Log API call before making request
      logger.logApiCall(entry.source, entry.destination, api, 'REQUEST', entry.index);

      // Make request to destination service (LSP or GW)
      const response = await makeRequest(
        this.getServiceBaseUrl(service),
        api,
        'POST',
        entry.payload,
        entry.requestId,
        sourceDestinationForRequest,
        entry.logTag,
        null,
        customHeaders,
        entry.index
      );

      // Log API response
      if (expectedResponse) {
        logger.logApiCall(entry.destination, entry.source, api, 'RESPONSE', expectedResponse.index);
      }

      // Compare response with expected
      if (expectedResponse) {
        const comparison = this.comparePayloads(
          expectedResponse.payload,
          response.data,
          expectedResponse.logTag
        );

        if (!comparison.match) {
          this.recordFailure('external_response_comparison', entry, comparison.differences);
          throw new Error(`Payload comparison failed: ${JSON.stringify(comparison.differences)}`);
        } else {
          logger.info('External request response validated', {
            request: entry.toString(),
            response: expectedResponse.toString(),
            actualResponse: response.data
          });
          this.recordSuccess('external_response_validation', expectedResponse);
        }

        // Mark both request and response as processed
        this.validator.advance(); // request
        this.validator.markProcessed(expectedResponse); // response
      } else {
        this.validator.advance();
      }

      // Continue to next entry
      await this.processNextLogEntry();

    } catch (error) {
      logger.error('Failed to trigger external request', {
        entry: entry.toString(),
        error: error.message
      });
      this.recordFailure('external_request_trigger', entry, error.message);
    }
  }

  /**
   * Get API endpoint for a log tag
   * Delegates to config.js
   */
  getApiForLogTag(logTag) {
    return getApiFromConfig(logTag) || '/api/unknown';
  }

  /**
   * Stop the replay session
   */
  async stop() {
    this.isRunning = false;
    this.stateManager.cleanup();
    logger.info('Replay orchestrator stopped');
  }

  /**
   * Clear LSP data after journey completion (success, failure, or stop)
   * Calls POST /art/data/clear with empty payload
   */
  async clearLspData(merchantId, orderId) {
    logger.info('Clearing LSP data via art/data/clear');

    try {
      const lspBaseUrl = this.getServiceBaseUrl('LSP');
      const url = `${lspBaseUrl}/art/data/clear`;

      const response = await fetch(url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Accept': 'application/json'
        },
        body: JSON.stringify({ merchantId, orderId})
      });

      if (response.ok) {
        logger.info('LSP data cleared successfully', {
          status: response.status
        });
      } else {
        logger.warn('Failed to clear LSP data', {
          status: response.status,
          statusText: response.statusText
        });
      }
    } catch (error) {
      logger.error('Error clearing LSP data', {
        error: error.message
      });
      // Don't throw - we want cleanup to continue even if this fails
    }
  }

  /**
   * Handle incoming request from a service (LSP or GW)
   *
   * Flow:
   * 1. Validate request matches expected log sequence
   * 2. Compare with expected payload
   * 3. Forward to destination service
   * 4. Return response (may be early or wait for actual response)
   *
   * @param {Object} incoming - { source, destination, api, payload, requestId, headers }
   * @returns {Promise<Object>} - Response to return to caller
   */
  async handleIncomingRequest(incoming) {
    if (!this.isRunning) {
      throw new Error('Orchestrator not running');
    }

    logger.info('Received incoming request', {
      source: incoming.source,
      destination: incoming.destination,
      api: incoming.api,
      requestId: incoming.requestId
    });

    // Get current expected entry
    const expectedEntry = this.validator.getCurrentEntry();

    if (!expectedEntry) {
      return await this.fail('No more entries to process - unexpected request');
    }

    // Validate this request matches expected
    const validation = this.validator.validateIncomingRequest({
      source: incoming.source,
      destination: incoming.destination,
      logTag: incoming.logTag,
      isRequest: true,
      requestId: incoming.requestId,
      lenderOrgId: incoming.lenderOrgId
    });

    // Check if this is a response from a skipped external service (e.g., LENDER→GW)
    // This handles out-of-order responses where response arrives before the orchestrator expects it
    if (incoming.source === 'LENDER' && incoming.destination === 'GW') {
      return await this.handleExternalServiceResponse(incoming);
    }

    // Check if this is a retried request that we already processed
    // This handles GW retries for lender calls that were already mocked
    const retryResult = this.handleRetryRequest(incoming);
    if (retryResult) {
      logger.info('Handled retried request', {
        source: incoming.source,
        destination: incoming.destination,
        api: incoming.api
      });
      return retryResult;
    }

    // If validation failed, check if we need to handle out-of-order scenarios
    if (!validation.valid && (validation.foundInLookahead || validation.isAsyncParallelCall)) {
      // There's a mismatch - we might have a webhook, intermediate call, or async/parallel API call
      return await this.handleOutOfOrderRequest(incoming, validation);
    }

    // Handle case where we're expecting a response but got a request
    // Try retry detection one more time before failing
    if (validation.isEarly) {
      logger.debug('Got request when expecting response, checking for retries', {
        expected: expectedEntry?.toString(),
        received: `${incoming.source}→${incoming.destination} ${incoming.logTag}`
      });

      // If we have processed entries matching this request, return cached response
      const processedEntry = this.validator.entries.find(entry =>
        this.validator.processedIndices.has(entry.index) &&
        entry.isRequest &&
        entry.source === incoming.source &&
        entry.destination === incoming.destination &&
        entry.logTag === incoming.logTag
      );

      if (processedEntry) {
        const responseEntry = this.findCorrespondingResponse(processedEntry, true);
        if (responseEntry) {
          logger.info('Returning cached response for processed entry', {
            entry: processedEntry.toString()
          });
          return {
            success: true,
            payload: responseEntry.payload,
            cached: true
          };
        }
      }
    }

    if (!validation.valid) {
      // Last resort: if this looks like a retry of a processed entry, return cached response
      if (validation.error?.includes('Expected response') && validation.error?.includes('received request')) {
        logger.info('Last resort check: looking for processed entry', {
          source: incoming.source,
          dest: incoming.destination,
          logTag: incoming.logTag,
          lenderOrgId: incoming.lenderOrgId,
          processedCount: this.validator.processedIndices.size
        });

        const processedEntry = this.validator.entries.find(entry =>
          this.validator.processedIndices.has(entry.index) &&
          entry.isRequest &&
          entry.source === incoming.source &&
          entry.destination === incoming.destination &&
          entry.logTag === incoming.logTag &&
          (!incoming.lenderOrgId || !entry.lenderOrgId || entry.lenderOrgId === incoming.lenderOrgId)
        );

        if (processedEntry) {
          logger.info('Last resort: found processed entry', {
            entry: processedEntry.toString()
          });
          const responseEntry = this.findCorrespondingResponse(processedEntry, true);
          if (responseEntry) {
            logger.info('Last resort: Returning cached response for processed entry', {
              entry: processedEntry.toString()
            });
            return {
              success: true,
              payload: responseEntry.payload,
              cached: true
            };
          } else {
            logger.warn('Last resort: found processed entry but no response entry');
          }
        } else {
          logger.warn('Last resort: no processed entry found matching criteria');
        }
      }

      return await this.fail(validation.error);
    }


    // Validation passed - check if there's a buffered request for this expected entry
    const buffered = this.stateManager.findBufferedRequest({
      source: expectedEntry.source,
      destination: expectedEntry.destination,
      logTag: expectedEntry.logTag
    });

    if (buffered) {
      // Remove the buffered request and use it instead of the new one
      this.stateManager.removeBufferedRequest(buffered.key);
      logger.info('Using buffered request instead of new one', {
        bufferedKey: buffered.key,
        newRequestId: incoming.requestId,
        bufferedRequestId: buffered.data.requestId
      });
      // Compare payloads using the buffered request
      incoming = buffered.data;
    }

    // Log incoming request
    logger.logApiCall(incoming.source, incoming.destination, incoming.api, 'REQUEST', expectedEntry.index);

    // Compare payloads
    const expectedPayload = expectedEntry.payload;
    const comparison = this.comparePayloads(expectedPayload, incoming.payload, incoming.logTag);

    if (!comparison.match) {
      return await this.fail('Payload comparison failed', comparison.differences);
    }

    // Initialize async tracking for parent requests that will trigger async child calls
    // This happens when LSP->GW comes in and we expect GW->LENDER calls to follow
    if (expectedEntry.source === 'LSP' && expectedEntry.destination === 'GW') {
      const contextKey = this.getContextKey(expectedEntry);
      const existingTracker = this.asyncCallTracker.get(contextKey);
      if (!existingTracker) {
        this.initializeAsyncTracking(expectedEntry);
      }
    }

    logger.info('Request validation passed', {
      entry: expectedEntry.toString(),
      comparisonMatch: true
    });

    // Mark entry as processed
    this.validator.advance();
    this.recordSuccess('request_validation', expectedEntry);

    // Forward to destination and validate the actual response
    // Let GW drive the flow - when GW is satisfied with all its LENDER calls,
    // it will respond to Orchestrator, which validates and forwards to LSP
    const response = await this.forwardToDestination(incoming, expectedEntry);

    // Check if we have count-based async tracking for this request
    const contextKey = this.getContextKey(expectedEntry);
    const tracker = this.asyncCallTracker.get(contextKey);

    if (tracker && tracker.expected > 0) {
      // We expect async calls - wait for count-based completion
      logger.info('Parent request forwarded, waiting for async calls to complete', {
        contextKey,
        expectedAsyncCalls: tracker.expected
      });
      await this.waitForAllExternalCalls();

      // Clean up tracking after completion
      this.cleanupAsyncTracking(contextKey);
    } else if (response?.externalSkipped) {
      // Legacy: wait for external calls tracked via promises
      await this.waitForAllExternalCalls();
    }

    return response;
  }

  /**
   * Handle response from downstream service
   * This is called when we receive a response from GW/LSP after forwarding a request
   *
   * @param {Object} incomingResponse - { source, destination, api, payload, correlationId }
   * @returns {Promise<Object>} - Comparison result
   */
  async handleDownstreamResponse(incomingResponse) {
    logger.info('Received downstream response', {
      source: incomingResponse.source,
      destination: incomingResponse.destination,
      api: incomingResponse.api,
      correlationId: incomingResponse.correlationId
    });

    // Get next expected entry (should be a response)
    const expectedEntry = this.validator.getCurrentEntry();

    if (!expectedEntry) {
      return await this.fail('No more entries to process - unexpected response');
    }

    // Validate this is the expected response
    const isExpectedResponse =
      expectedEntry.isResponse &&
      expectedEntry.source === incomingResponse.source &&
      expectedEntry.destination === incomingResponse.destination &&
      expectedEntry.logTag === incomingResponse.logTag;

    if (!isExpectedResponse) {
      // This might be an early response - buffer it
      logger.debug('Response does not match expected, buffering', {
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
    const comparison = this.comparePayloads(expectedPayload, incomingResponse.payload, incomingResponse.logTag);

    if (!comparison.match) {
      return await this.fail('Response comparison failed', comparison.differences);
    }

    logger.info('Response validation passed', {
      entry: expectedEntry.toString()
    });

    // Mark entry as processed
    this.validator.advance();
    this.recordSuccess('response_validation', expectedEntry);

    // Trigger next log entry processing (for external source requests like APP->LSP)
    logger.info('Triggering processNextLogEntry after response validation');
    setImmediate(() => {
      logger.info('Executing setImmediate processNextLogEntry');
      this.processNextLogEntry().catch(err => {
        logger.error('Error processing next log entry after response validation', { error: err.message });
      });
    });

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
      logger.info('Skipping external destination (tracked for async response)', {
        destination,
        api,
        requestId: incoming.requestId,
        logTag: expectedEntry.logTag.replace('Request', 'Response').replace('INCOMING', 'OUTGOING'), // Derive expected response log tag,
        sourceDestination: expectedEntry.sourceDestination
      });

      // Find the expected response from logs
      const expectedResponse = this.findCorrespondingResponse(expectedEntry);
      if (!expectedResponse) {
        return await this.fail(`No expected response found for skipped destination ${destination}`);
      }

      // Track this pending external request by context for out-of-order matching
      const contextKey = this.getContextKey(expectedEntry);

      // For LENDER calls, check for webhooks that should fire BEFORE the response
      let webhooksBefore = [];
      if (destination === 'LENDER') {
        webhooksBefore = this.validator.findWebhooksForLenderCall(expectedEntry, expectedResponse, 'before');
        if (webhooksBefore.length > 0) {
          logger.info(`Found ${webhooksBefore.length} webhook(s) to trigger before LENDER response`, {
            requestEntry: expectedEntry.toString()
          });
          // Trigger webhooks before responding
          await this.triggerWebhooks(webhooksBefore);
        }
      }

      // Log mocked request and response
      logger.logApiCall(expectedEntry.source, expectedEntry.destination, api, 'REQUEST', expectedEntry.index);
      logger.logApiCall(expectedResponse.source, expectedResponse.destination, api, 'RESPONSE', expectedResponse.index);

      // For LENDER calls, check for webhooks that should fire AFTER the response (CASE 7)
      let webhooksAfter = [];
      if (destination === 'LENDER') {
        webhooksAfter = this.validator.findWebhooksAfterLenderResponse(expectedResponse, null);
        if (webhooksAfter.length > 0) {
          logger.info(`Found ${webhooksAfter.length} webhook(s) to trigger after LENDER response`, {
            responseEntry: expectedResponse.toString()
          });
          // Store webhooks to trigger after we send the response back to GW
          this.pendingPostResponseWebhooks = this.pendingPostResponseWebhooks || new Map();
          this.pendingPostResponseWebhooks.set(contextKey, webhooksAfter);
        }
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
          logger.info('Processing early-arrived response now', { contextKey });
          this.earlyExternalResponses.delete(contextKey);
          // Process immediately (but don't return - continue with normal response)
          this.handleExternalServiceResponse(earlyResponse).catch(err => {
            logger.error('Error processing early response', { error: err.message });
          });
        }

        logger.debug('Tracked pending external request', {
          contextKey,
          requestIndex: expectedEntry.index,
          expectedResponseIndex: expectedResponse.index
        });

        // Track this external call so we can wait for it before returning response to caller
        logger.info('Tracking external call for later wait', {
          contextKey,
          source: incoming.source,
          destination: incoming.destination
        });

        // Return marker so caller knows to wait for all pending external calls
        return {
          success: true,
          payload: expectedResponse.payload,
          tracked: true,
          externalSkipped: true
        };
      }

      // No webhooks expected - mark entries as processed and return immediately
      logger.info('No webhooks expected for external call, completing immediately', {
        contextKey,
        destination
      });

      // Mark entries as processed
      this.validator.advance(); // request
      this.validator.markProcessed(expectedResponse); // response

      // Track async completion for count-based handling
      // For async parallel calls, use orderId as context key to match the tracker
      const asyncContextKey = expectedEntry.orderId || contextKey;
      const isComplete = this.trackAsyncCompletion(asyncContextKey, expectedEntry);

      // Return success immediately without tracking/waiting
      return {
        success: true,
        payload: expectedResponse.payload,
        tracked: false,
        externalSkipped: false,
        asyncComplete: isComplete
      };
    }

    logger.info('Forwarding to destination', {
      destination,
      api,
      requestId: incoming.requestId
    });

    // Get endpoint config for custom headers
    const endpointConfig = getEndpointConfig(expectedEntry.sourceDestination, expectedEntry.logTag);
    const customHeaders = { ...incoming.headers, ...endpointConfig?.headers };

    try {
      // Generate correlation key for tracking
      const correlationKey = StateManager.generateCorrelationKey(
        api,
        expectedEntry.sourceDestination,
        incoming.requestId
      );

      // Find the expected response entry (may not be the immediate next entry)
      const expectedResponse = this.findCorrespondingResponse(expectedEntry);
      logger.info('Found expected response for request', {
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

      // Make actual HTTP request to destination
      // This would use the http-client with actual endpoint mapping
      const serviceResponse = await makeRequest(
        this.getServiceBaseUrl(destination),
        api,
        'POST', // Method should come from config
        incoming.payload,
        incoming.requestId,
        sourceDestinationForRequest,
        expectedEntry.logTag,
        null, // merchantId
        customHeaders,
        expectedEntry.index
      );

      // If response came synchronously, handle it
      if (serviceResponse && !serviceResponse.error) {
        // Store response headers for forwarding
        if (serviceResponse.headers) {
          this.stateManager.storeResponseHeaders(correlationKey, serviceResponse.headers);
        }

        // Validate response against expected
        if (expectedResponse) {
          const comparison = this.comparePayloads(
            expectedResponse.payload,
            serviceResponse.data,
            expectedResponse.logTag
          );

          if (!comparison.match) {
            this.recordFailure('downstream_response_comparison', expectedResponse, comparison.differences);
          } else {
            logger.info('Downstream response validated', {
              request: expectedEntry.toString(),
              response: expectedResponse.toString()
            });
            this.recordSuccess('downstream_response_validation', expectedResponse);
          }

          // Mark response as processed
          this.validator.markProcessed(expectedResponse);
        }

        // Log API response
        if (expectedResponse) {
          logger.logApiCall(expectedResponse.source, expectedResponse.destination, api, 'RESPONSE', expectedResponse.index);
        }

        // Try to match with pending
        const handled = this.stateManager.handleIncomingResponse(
          correlationKey,
          serviceResponse.data
        );

        if (handled) {
          // Response was matched with pending request - include headers
          // Trigger next log entry processing for external source requests
          logger.info('Triggering processNextLogEntry after sync downstream response');
          setImmediate(() => {
            this.processNextLogEntry().catch(err => {
              logger.error('Error processing next log entry after sync response', { error: err.message });
            });
          });
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
        logger.logApiCall(expectedResponse.source, expectedResponse.destination, api, 'RESPONSE', expectedResponse.index);
      }

      // Get stored headers and include in response
      const storedHeaders = this.stateManager.getResponseHeaders(correlationKey);

      // Validate and mark expected response as processed if not already done
      if (expectedResponse && !this.validator.processedIndices.has(expectedResponse.index)) {
        this.validator.markProcessed(expectedResponse);
        this.recordSuccess('downstream_response_validation', expectedResponse);
      }

      // Trigger next log entry processing for external source requests
      logger.info('Triggering processNextLogEntry after async downstream response');
      setImmediate(() => {
        this.processNextLogEntry().catch(err => {
          logger.error('Error processing next log entry after async response', { error: err.message });
        });
      });

      return {
        ...finalResponse,
        headers: finalResponse.headers || storedHeaders
      };

    } catch (error) {
      logger.error('Failed to forward request', {
        destination,
        api,
        error: error.message
      });
      throw error;
    }
  }

  /**
   * Handle out-of-order request (webhook or intermediate call)
   *
   * Special handling for Themis-Eligibility requests (GW→LENDER):
   * These are parallel calls from Gateway that can arrive in any order.
   * Instead of immediately mocking the expected entry, we wait for the
   * actual call with a timeout, allowing out-of-order parallel processing.
   */
  async handleOutOfOrderRequest(incoming, validation) {
    logger.warn('Handling out-of-order request', {
      expected: validation.expectedEntry?.toString(),
      received: `${incoming.source}→${incoming.destination} ${incoming.logTag}`,
      foundInLookahead: validation.foundInLookahead?.toString()
    });

    const currentEntry = validation.expectedEntry;

    // Check if current expected is a request we need to trigger ourselves
    if (currentEntry?.isRequest && currentEntry.isExternalDestination()) {
      // For async/parallel calls, process immediately by finding matching log entry
      if (this.isAsyncParallelCall(currentEntry)) {
        return await this.processAsyncParallelCall(incoming, validation.foundInLookahead);
      }

      // For other external calls, mock immediately (existing behavior)
      logger.info('Need to mock external request first', {
        entry: currentEntry.toString()
      });

      // Trigger the external request mock
      await this.mockExternalRequest(currentEntry);

      // Now retry validation
      return this.handleIncomingRequest(incoming);
    }

    // Buffer this request and wait for expected sequence
    const requestKey = StateManager.generateRequestKey(
      incoming.source,
      incoming.api,
      incoming.requestId
    );

    this.stateManager.bufferIncomingRequest(requestKey, incoming);

    return await this.fail(`Request out of order. Expected: ${currentEntry?.toString()}`);
  }

  /**
   * Check if this is an async/parallel API call
   * These calls are made in parallel and can arrive in any order
   */
  isAsyncParallelCall(entry) {
    return isAsyncParallelApi(entry?.sourceDestination, entry?.logTag);
  }

  /**
   * Process an async/parallel API call immediately.
   * Finds the matching log entry by lenderOrgId and processes it,
   * regardless of the expected sequence order.
   */
  async processAsyncParallelCall(incoming, matchingEntry) {
    logger.info('Processing async/parallel call immediately', {
      incoming: `${incoming.source}→${incoming.destination} ${incoming.logTag}`,
      lenderOrgId: incoming.lenderOrgId,
      matchedEntry: matchingEntry?.toString()
    });

    if (!matchingEntry) {
      return await this.fail(
        `No log entry found for lenderOrgId "${incoming.lenderOrgId}". ` +
        `Expected log for: ${incoming.source}→${incoming.destination} ${incoming.logTag}`
      );
    }

    // Use the matching entry instead of the current expected entry
    const expectedEntry = matchingEntry;

    // Log the API call
    logger.logApiCall(incoming.source, incoming.destination, incoming.api, 'REQUEST', expectedEntry.index);

    // Compare payloads
    const expectedPayload = expectedEntry.payload;
    const comparison = this.comparePayloads(expectedPayload, incoming.payload, incoming.logTag);

    if (!comparison.match) {
      return await this.fail('Payload comparison failed', comparison.differences);
    }

    logger.info('Request validation passed', {
      entry: expectedEntry.toString(),
      comparisonMatch: true
    });

    // For async parallel calls processed out of order:
    // 1. Mark matching entry as processed
    // 2. Mock any unprocessed async entries (not just between current and target)
    if (this.isAsyncParallelCall(expectedEntry)) {
      // Find and mock any unprocessed async entries
      // This handles out-of-order arrivals like: SMICC (5), TVS_CREDIT (10), HDB (7)
      for (const entry of this.validator.entries) {
        if (this.validator.processedIndices.has(entry.index)) continue;
        if (!this.isAsyncParallelCall(entry)) continue;
        if (!entry.isRequest) continue;
        if (entry.index === expectedEntry.index) continue; // Will handle below

        logger.info('Mocking unprocessed async entry', {
          entry: entry.toString()
        });
        // Mock this entry
        const responseEntry = this.findCorrespondingResponse(entry);
        if (responseEntry) {
          this.validator.processedIndices.add(entry.index);
          this.validator.processedIndices.add(responseEntry.index);
          this.recordSuccess('request_validation', entry);
          this.recordSuccess('response_validation', responseEntry);

          // Track async completion for skipped entries too
          const skippedContextKey = entry.orderId || this.getContextKey(entry);
          this.trackAsyncCompletion(skippedContextKey, entry);
        }
      }

      // Now mark the actual entry as processed
      this.validator.processedIndices.add(expectedEntry.index);
      logger.debug('Marked async parallel entry as processed', {
        entry: expectedEntry.toString(),
        index: expectedEntry.index
      });
    } else {
      this.validator.markProcessed(expectedEntry);
    }
    this.recordSuccess('request_validation', expectedEntry);

    // Track async completion for count-based handling
    // For async parallel calls, use orderId as context key to match the tracker
    // initialized from parent LSP->GW request (which doesn't have lenderOrgId)
    const contextKey = expectedEntry.orderId || this.getContextKey(expectedEntry);
    const isComplete = this.trackAsyncCompletion(contextKey, expectedEntry);
    logger.debug('Tracked async parallel call completion', {
      contextKey,
      lenderOrgId: expectedEntry.lenderOrgId,
      isComplete
    });

    // Forward to destination (returns mock response for LENDER)
    return await this.forwardToDestination(incoming, expectedEntry);
  }

  /**
   * Find a buffered request that matches the expected async call
   */
  findBufferedAsyncCall(expectedEntry) {
    // Use StateManager's method to find by lenderOrgId
    const found = this.stateManager.findBufferedRequestByLenderOrgId(expectedEntry.lenderOrgId);
    if (found &&
        found.data.source === expectedEntry.source &&
        found.data.destination === expectedEntry.destination &&
        found.data.logTag === expectedEntry.logTag) {
      return found;
    }
    return null;
  }

  /**
   * Count pending async/parallel API calls
   */
  countPendingAsyncParallelCalls() {
    let count = 0;
    const lookahead = this.validator.peekNext(50);

    for (const entry of lookahead) {
      if (this.isAsyncParallelCall(entry) && !this.validator.processedIndices.has(entry.index)) {
        count++;
      }
    }

    return count;
  }

  /**
   * Process a buffered request through handleIncomingRequest
   */
  async processBufferedRequest(requestData) {
    return await this.handleIncomingRequest(requestData);
  }

  /**
   * Process all buffered async/parallel API calls in log sequence order.
   * This handles multiple out-of-order calls that arrived while waiting.
   */
  async processAllBufferedAsyncCalls() {
    // Keep processing as long as there are buffered async calls that match expected entries
    let processed = 0;

    while (true) {
      const currentEntry = this.validator.getCurrentEntry();
      if (!currentEntry || !this.isAsyncParallelCall(currentEntry)) {
        break; // No more async calls expected
      }

      // Look for a buffered call matching the current expected entry
      const buffered = this.findBufferedAsyncCall(currentEntry);
      if (!buffered) {
        break; // No matching buffered call found
      }

      // Remove and process this buffered call
      this.stateManager.removeBufferedRequest(buffered.key);
      logger.info('Processing buffered async call', {
        expected: currentEntry.toString(),
        bufferedKey: buffered.key
      });

      await this.processBufferedRequest(buffered.data);
      processed++;
    }

    if (processed > 0) {
      logger.info(`Processed ${processed} buffered async call(s)`);
    }
  }

  /**
   * Sleep utility for async waiting
   */
  sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
  }

  /**
   * Mock an external request (e.g., LENDER callback/webhook)
   */
  async mockExternalRequest(expectedEntry) {
    logger.info('Mocking external request', {
      entry: expectedEntry.toString()
    });

    // Find the corresponding response in logs
    const responseEntry = this.findCorrespondingResponse(expectedEntry);

    if (!responseEntry) {
      throw new Error(`No corresponding response found for ${expectedEntry.toString()}`);
    }

    // Mock sending the external request and getting response
    // In reality, this would trigger the webhook/callback to GW

    // Mark both request and response as processed
    this.validator.markProcessed(expectedEntry);
    this.validator.markProcessed(responseEntry);

    logger.info('External request mocked successfully', {
      request: expectedEntry.toString(),
      response: responseEntry.toString()
    });
  }

  /**
   * Handle response from an external service (e.g., LENDER→GW callback)
   * Matches by context (loan_application_id, lender_org_id) to find the corresponding request
   */
  async handleExternalServiceResponse(incoming) {
    // Build context key from incoming response payload
    const incomingLoanAppId = incoming.payload?.loan_application_id || incoming.payload?.applicationid;
    const incomingLenderOrgId = incoming.payload?.lender_org_id;
    const contextKey = [incomingLoanAppId, incomingLenderOrgId].filter(Boolean).join(':');

    logger.info('Handling external service response', {
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
      const responseContextKey = this.getContextKey(value.responseEntry);
      if (responseContextKey === contextKey || key === contextKey) {
        matchedEntry = value.requestEntry;
        matchedResponse = value.responseEntry;
        pendingInfo = value;
        this.pendingExternalRequests.delete(key);
        logger.info('Matched external response to pending request', {
          requestIndex: matchedEntry.index,
          responseIndex: matchedResponse.index,
          contextKey
        });
        break;
      }
    }

    // If no match, check if response arrived early (before we tracked the request)
    if (!matchedResponse) {
      logger.warn('No pending external request found for response, buffering', {
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
    const comparison = this.comparePayloads(
      matchedResponse.payload,
      incoming.payload,
      incoming.logTag || matchedResponse.logTag
    );

    if (!comparison.match) {
      return await this.fail('External response comparison failed', comparison.differences);
    }

    // Mark both request and response as processed in the validator
    // First mark the request entry as processed
    if (matchedEntry.index < this.validator.currentIndex) {
      // Already passed - no need to mark
      logger.debug('Request entry already passed', { index: matchedEntry.index });
    } else if (matchedEntry.index === this.validator.currentIndex) {
      // Currently at this entry - advance
      this.validator.advance();
    } else {
      // Ahead of current - mark as processed without advancing through intervening entries
      this.validator.markProcessed(matchedEntry);
    }

    // Mark the response as processed (it's after the request)
    this.validator.markProcessed(matchedResponse);
    this.recordSuccess('external_response_matched', matchedResponse);

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
    logger.info('handleRetryRequest called', {
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
        if (contextMatches && incoming.lenderOrgId && requestEntry.lenderOrgId) {
          contextMatches = incoming.lenderOrgId === requestEntry.lenderOrgId;
        }

        // For async parallel calls, lenderOrgId MUST match - don't treat as retry if different lenders
        if (contextMatches && this.isAsyncParallelCall(requestEntry)) {
          if (incoming.lenderOrgId !== requestEntry.lenderOrgId) {
            logger.debug('Not a retry - different lender for async parallel call', {
              incomingLender: incoming.lenderOrgId,
              expectedLender: requestEntry.lenderOrgId
            });
            continue; // Skip to next pending entry
          }
        }

        if (contextMatches) {
          logger.info('Detected retried request for pending external call', {
            source: incoming.source,
            destination: incoming.destination,
            api: incoming.api,
            contextKey
          });

          // Return the expected response payload
          return {
            success: true,
            payload: pendingInfo.responseEntry.payload,
            retried: true
          };
        }
      }
    }

    // Also check processed indices for recently completed external calls
    // (in case the webhook arrived and cleared the pending entry)
    const processedEntries = this.validator.entries.filter(
      (_entry, index) => this.validator.processedIndices.has(index)
    );

    logger.debug('Checking processed entries for retry', {
      incomingSource: incoming.source,
      incomingDest: incoming.destination,
      incomingLogTag: incoming.logTag,
      incomingLenderOrgId: incoming.lenderOrgId,
      processedCount: processedEntries.length
    });

    for (const entry of processedEntries) {
      logger.debug('Checking entry for retry match', {
        entrySource: entry.source,
        entryDest: entry.destination,
        entryLogTag: entry.logTag,
        entryLenderOrgId: entry.lenderOrgId,
        entryIndex: entry.index,
        isAsync: this.isAsyncParallelCall(entry)
      });

      if (
        entry.isRequest &&
        entry.source === incoming.source &&
        entry.destination === incoming.destination &&
        entry.logTag === incoming.logTag
      ) {
        logger.debug('Entry matches source/dest/logTag');
        // Check context match
        let contextMatches = true;
        if (incoming.loanApplicationId && entry.loanApplicationId) {
          contextMatches = incoming.loanApplicationId === entry.loanApplicationId;
        }

        // For async parallel calls, lenderOrgId is the primary identifier
        // because GW reuses the same requestId for all parallel calls
        if (this.isAsyncParallelCall(entry)) {
          // If we have lenderOrgId in both, they must match
          if (incoming.lenderOrgId && entry.lenderOrgId) {
            if (incoming.lenderOrgId !== entry.lenderOrgId) {
              // Different lender - this is NOT a retry of this entry
              // But since GW retries all parallel calls with same requestId,
              // we should check if ANY processed entry matches
              continue;
            }
          }
          // If entry has lenderOrgId but incoming doesn't, or vice versa,
          // we still treat it as a potential retry since GW uses same requestId
          // for all parallel calls. The source/dest/logTag match is sufficient.
        } else if (contextMatches && incoming.lenderOrgId && entry.lenderOrgId) {
          // Non-async calls: lenderOrgId must match if present
          contextMatches = incoming.lenderOrgId === entry.lenderOrgId;
        }

        if (contextMatches) {
          // Find the corresponding response (search all entries including processed)
          const responseEntry = this.findCorrespondingResponse(entry, true);
          if (responseEntry) {
            logger.info('Detected retried request for completed external call', {
              source: incoming.source,
              destination: incoming.destination,
              api: incoming.api
            });

            return {
              success: true,
              payload: responseEntry.payload,
              retried: true
            };
          }
        }
      }
    }

    return null; // Not a retry
  }

  /**
   * Wait for pending external requests that were triggered by the current request flow.
   * This ensures external service calls (like GW→LENDER) complete before returning
   * responses to the caller (like LSP←GW).
   *
   * @param {LogEntry} currentEntry - The current request entry being processed
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
      } else if (currentEntry.loanApplicationId && pendingInfo.requestEntry.loanApplicationId) {
        isRelated = currentEntry.loanApplicationId === pendingInfo.requestEntry.loanApplicationId;
      } else if (currentEntry.lenderOrgId && pendingInfo.requestEntry.lenderOrgId) {
        isRelated = currentEntry.lenderOrgId === pendingInfo.requestEntry.lenderOrgId;
      }

      if (isRelated) {
        logger.info('Waiting for pending external request', {
          contextKey,
          currentEntry: currentEntry.toString(),
          pendingRequest: pendingInfo.requestEntry.toString()
        });
        promisesToWait.push(pendingInfo.promise);
      }
    }

    if (promisesToWait.length > 0) {
      logger.info(`Waiting for ${promisesToWait.length} pending external request(s)`, {
        currentEntry: currentEntry.toString()
      });

      try {
        await Promise.all(promisesToWait);
        logger.info('All pending external requests completed', {
          currentEntry: currentEntry.toString()
        });
      } catch (error) {
        logger.error('Error waiting for pending external requests', {
          currentEntry: currentEntry.toString(),
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
   * @param {LogEntry} parentRequestEntry - The parent request (e.g., LSP→GW)
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

    logger.info('Initialized async call tracking', {
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
   * @param {LogEntry} entry - The completed entry
   * @returns {boolean} - True if all async calls for this context are complete
   */
  trackAsyncCompletion(contextKey, entry) {
    const tracker = this.asyncCallTracker.get(contextKey);
    if (!tracker) {
      logger.warn('No async tracker found for context', { contextKey });
      return false;
    }

    // Track by index to avoid double-counting
    if (tracker.entries.has(entry.index)) {
      logger.debug('Async entry already tracked', { index: entry.index });
      return tracker.actual >= tracker.expected;
    }

    tracker.entries.add(entry.index);
    tracker.actual++;

    const isComplete = tracker.actual >= tracker.expected;

    logger.info('Tracked async completion', {
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
      logger.debug('Cleaning up async tracking', { contextKey });
      this.asyncCallTracker.delete(contextKey);
    }
  }

  /**
   * Wait for all pending external calls to complete.
   * Uses count-based completion: waits until actual processed count matches expected count.
   * This ensures that when LSP→GW is processed, all GW→LENDER calls complete
   * before returning GW→LSP response.
   */
  async waitForAllExternalCalls() {
    // First check if we're using count-based tracking
    for (const [contextKey, tracker] of this.asyncCallTracker.entries()) {
      if (tracker.expected > 0 && tracker.actual < tracker.expected) {
        logger.info(`Waiting for async calls to complete (count-based)`, {
          contextKey,
          actual: tracker.actual,
          expected: tracker.expected
        });

        // Poll until completion or timeout
        const startTime = Date.now();
        const timeoutMs = this.config.timeoutMs || 10000;

        while (tracker.actual < tracker.expected) {
          if (Date.now() - startTime > timeoutMs) {
            logger.warn(`Timeout waiting for async calls`, {
              contextKey,
              actual: tracker.actual,
              expected: tracker.expected
            });
            break;
          }
          // Wait a bit before checking again
          await this.sleep(100);
        }

        logger.info(`Async calls completion status`, {
          contextKey,
          actual: tracker.actual,
          expected: tracker.expected,
          complete: tracker.actual >= tracker.expected
        });
      }
    }

    // Also wait for any tracked external requests (webhook-based tracking)
    if (this.pendingExternalRequests.size > 0) {
      logger.info(`Waiting for ${this.pendingExternalRequests.size} external call(s) to complete`);

      const promisesToWait = [];
      for (const [, pendingInfo] of this.pendingExternalRequests.entries()) {
        promisesToWait.push(pendingInfo.promise);
      }

      if (promisesToWait.length > 0) {
        try {
          await Promise.all(promisesToWait);
          logger.info('All external calls completed');
        } catch (error) {
          logger.error('Some external calls failed', {
            error: error.message
          });
          // Don't throw - continue with response
        }
      }
    }

    // After all external calls complete, trigger any post-response webhooks (CASE 7)
    if (this.pendingPostResponseWebhooks && this.pendingPostResponseWebhooks.size > 0) {
      for (const [contextKey, webhooks] of this.pendingPostResponseWebhooks.entries()) {
        logger.info(`Triggering ${webhooks.length} post-response webhook(s) for ${contextKey}`);
        await this.triggerWebhooks(webhooks);
      }
      this.pendingPostResponseWebhooks.clear();
    }

    // Also find and trigger APP->GW webhooks that should fire after GW->APP response
    await this.triggerAppWebhooksAfterResponse();
  }

  /**
   * Find and trigger APP->GW webhooks that should fire after GW->APP response
   * This handles cases like FlipKart-EligibilityStatus after eligibility response
   */
  async triggerAppWebhooksAfterResponse() {
    // Find APP->GW webhook entries that haven't been processed yet
    const appWebhooks = [];
    const currentEntry = this.validator.getCurrentEntry();

    if (!currentEntry) return;

    // Look ahead for APP->GW webhooks
    const lookahead = this.validator.peekNext(100);
    for (const entry of lookahead) {
      if (entry.shouldSkip()) continue;

      // Stop if we hit a request that needs to be processed normally
      if (entry.isRequest && !entry.isExternalSource()) break;

      // Look for APP->GW webhooks
      if (entry.isWebhook() && entry.source === 'APP' && entry.destination === 'GW') {
        // Check if this webhook shares context with current flow
        const currentContextKey = this.getContextKey(currentEntry);
        const webhookContextKey = this.getContextKey(entry);

        if (currentContextKey === webhookContextKey || this.validator.contextsMatch(currentEntry, entry)) {
          appWebhooks.push(entry);
        }
      }
    }

    if (appWebhooks.length > 0) {
      logger.info(`Found ${appWebhooks.length} APP->GW webhook(s) to trigger after response`, {
        webhooks: appWebhooks.map(w => w.toString())
      });
      await this.triggerWebhooks(appWebhooks);
    }
  }

  /**
   * Trigger webhooks to GW
   * @param {Array<LogEntry>} webhooks - Array of webhook entries to trigger
   */
  async triggerWebhooks(webhooks) {
    for (const webhook of webhooks) {
      // Skip if already triggered
      if (this.triggeredWebhooks.has(webhook.index)) {
        logger.debug('Skipping already triggered webhook', { index: webhook.index });
        continue;
      }

      const lenderOrgId = webhook.lenderOrgId || webhook.payload?.lender_org_id;
      if (!lenderOrgId) {
        logger.warn('Cannot trigger webhook - no lender_org_id found', {
          webhook: webhook.toString()
        });
        continue;
      }

      try {
        const gwBaseUrl = this.getServiceBaseUrl('GW');
        const result = await triggerWebhook(
          gwBaseUrl,
          lenderOrgId,
          webhook.payload,
          {
            'x-request-id': webhook.requestId || `webhook-${webhook.index}`,
            'x-log-index': webhook.index.toString()
          }
        );

        if (result.success) {
          logger.info('Webhook triggered successfully', {
            index: webhook.index,
            lenderOrgId,
            status: result.status
          });
          this.triggeredWebhooks.add(webhook.index);
          // Mark webhook as processed in validator
          this.validator.markProcessed(webhook);
          this.recordSuccess('webhook_triggered', webhook);
        } else {
          logger.error('Failed to trigger webhook', {
            index: webhook.index,
            error: result.message
          });
          this.recordFailure('webhook_trigger', webhook, result.message);
        }
      } catch (error) {
        logger.error('Exception triggering webhook', {
          index: webhook.index,
          error: error.message
        });
        this.recordFailure('webhook_trigger', webhook, error.message);
      }
    }
  }

  /**
   * Get expected response for a given request from logs
   */
  async getExpectedResponse(requestEntry) {
    const responseEntry = this.findCorrespondingResponse(requestEntry);

    if (!responseEntry) {
      throw new Error(`No response found for request ${requestEntry.toString()}`);
    }

    // Mark response as processed and track it as mocked
    this.validator.markProcessed(responseEntry);
    this.mockedResponseIndices.add(responseEntry.index);

    return {
      success: true,
      payload: responseEntry.payload
    };
  }

  /**
   * Find the response entry corresponding to a request
   */
  findCorrespondingResponse(requestEntry, searchAll = false) {
    // Look for response with reversed source_destination and matching request context
    const direction = `${requestEntry.source}_${requestEntry.destination}`;

    // Search in remaining logs - look ahead further to handle interleaved entries
    // If searchAll is true, search through all entries including processed ones
    // This is needed for retry detection where both request and response are processed
    const entriesToSearch = searchAll
      ? this.validator.entries
      : this.validator.peekNext(100);

    for (const entry of entriesToSearch) {
      if (
        entry.isResponse &&
        entry.sourceDestination === direction &&
        this.matchesRequestContext(requestEntry, entry)
      ) {
        return entry;
      }
    }

    return null;
  }

  /**
   * Check if response matches request context (loan application ID, etc.)
   */
  matchesRequestContext(requestEntry, responseEntry) {
    // Match by loan_application_id if present
    if (
      requestEntry.loanApplicationId &&
      responseEntry.loanApplicationId &&
      requestEntry.loanApplicationId !== responseEntry.loanApplicationId
    ) {
      return false;
    }
    // Match by loan_application_id if present
    if (
      requestEntry.lenderOrgId &&
      responseEntry.lenderOrgId &&
      requestEntry.lenderOrgId !== responseEntry.lenderOrgId
    ) {
      return false;
    }

    // Match by request_id if present
    // if (requestEntry.requestId && responseEntry.requestId) {
    //   // In real traces, response might have related request_id
    //   return true; // Simplified - should check actual relationship
    // }

    return true; // Default to match for simple cases
  }

  /**
   * Compare payloads using existing comparator
   */
  comparePayloads(expected, actual, logTag) {
    return compareLog(expected, actual, logTag);
  }

  /**
   * Get service base URL from config
   */
  getServiceBaseUrl(serviceName) {
    const urls = {
      'LSP': process.env.LSP_URL || 'http://localhost:4232',
      'GW': process.env.GW_URL || 'http://localhost:2344'
    };
    const url = urls[serviceName];
    if (!url) {
      logger.warn('Unknown service, no base URL configured', { serviceName });
    }
    return url;
  }

  /**
   * Record success result
   */
  recordSuccess(step, entry) {
    this.results.passed++;
    this.results.processedLogs.push({
      step,
      entry: entry.toString(),
      timestamp: new Date().toISOString()
    });
  }

  /**
   * Record failure result
   */
  recordFailure(step, entry, details) {
    this.results.failed++;
    this.results.errors.push({
      step,
      entry: entry.toString(),
      details,
      timestamp: new Date().toISOString()
    });
    logger.error('Replay step failed', { step, entry: entry.toString(), details });
  }

  /**
   * Record failure result
   */
  async fail(error, details = null) {
    this.results.failed++;
    this.results.errors.push({
      error,
      details,
      timestamp: new Date().toISOString()
    });

    logger.error('Replay failed', { error, details });

    // Stop orchestrator and clear LSP data on failure
    this.isRunning = false;

    return {
      success: false,
      error,
      details
    };
  }

  /**
   * Get replay progress and results
   */
  getResults() {
    return {
      ...this.results,
      progress: this.validator.getProgress(),
      state: this.stateManager.getState()
    };
  }

  /**
   * Check if replay is complete
   */
  isComplete() {
    return this.validator.isComplete();
  }
}

export default ReplayOrchestrator;
