import { StateManager } from './services/state-manager.js';
import { LogSequenceValidator, LogEntry } from './services/log-sequence-validator.js';
import { makeRequest } from './services/http-client.js';
import { compareLog } from './services/comparator.js';
import { logger } from './utils/logger.js';
import { extractPayload, getApiForLogTag as getApiFromConfig, getEndpointConfig, SERVICE_MAP, SKIP_DESTINATIONS } from './config.js';

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
      timeoutMs: 30000,
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
    // Map<contextKey, {requestEntry, responseEntry}>
    this.pendingExternalRequests = new Map();

    // Buffer for early-arriving external responses (response arrives before tracking)
    // Map<contextKey, incoming>
    this.earlyExternalResponses = new Map();

    this.isRunning = false;
  }

  /**
   * Generate a context key for matching requests and responses
   * Based on loan_application_id and lender_org_id
   */
  getContextKey(entry) {
    const parts = [];
    if (entry.loanApplicationId) {
      parts.push(entry.loanApplicationId);
    }
    if (entry.lenderOrgId) {
      parts.push(entry.lenderOrgId);
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
      if (merchantId) {
        logger.info('Extracted merchantId from logs', { merchantId });
        return merchantId;
      }
    }
    throw new Error('merchant_id not found in logs. Seed data onboarding requires merchant_id.');
  }

  /**
   * Onboard seed data to LSP
   * Called before replay starts
   */
  async onboardSeedData(merchantId) {
    logger.info('Onboarding seed data to LSP: ', { baseUrl: SERVICE_MAP.LSP.baseUrl + '/art/set', merchantId });

    try {
      const response = await makeRequest(
        SERVICE_MAP.LSP.baseUrl,
        '/art/set',
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
    const merchantId = ReplayOrchestrator.extractMerchantId(this.logs);
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
      const api = this.getApiForLogTag(entry.logTag);

      // Get expected response for comparison later
      // Match by source/destination direction and correlation fields if present
      const expectedResponse = this.validator.peekNext(10).find(e => {
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
        customHeaders
      );

      // Compare response with expected
      if (expectedResponse) {
        const comparison = this.comparePayloads(
          expectedResponse.payload,
          response.data,
          expectedResponse.logTag
        );

        if (!comparison.match) {
          this.recordFailure('external_response_comparison', entry, comparison.differences);
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
      return this.fail('No more entries to process - unexpected request');
    }

    // Validate this request matches expected
    const validation = this.validator.validateIncomingRequest({
      source: incoming.source,
      destination: incoming.destination,
      logTag: incoming.logTag,
      isRequest: true,
      requestId: incoming.requestId,
      loanApplicationId: incoming.loanApplicationId,
      lenderOrgId: incoming.lenderOrgId
    });

    // Handle case where we're expecting a response but got a request
    // (Response might have arrived early and been buffered)
    if (validation.isEarly) {
      logger.debug('Got request when expecting response, checking buffers', {
        expected: expectedEntry.toString(),
        received: `${incoming.source}→${incoming.destination} ${incoming.logTag}`
      });
    }

    // Check if this is a response from a skipped external service (e.g., LENDER→GW)
    // This handles out-of-order responses where response arrives before the orchestrator expects it
    if (incoming.source === 'LENDER' && incoming.destination === 'GW') {
      return await this.handleExternalServiceResponse(incoming);
    }

    // If validation failed, check if we need to handle out-of-order scenarios
    if (!validation.valid && validation.foundInLookahead) {
      // There's a mismatch - we might have a webhook or intermediate call
      return await this.handleOutOfOrderRequest(incoming, validation);
    }

    if (!validation.valid) {
      return this.fail(validation.error);
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

    // Compare payloads
    const expectedPayload = expectedEntry.payload;
    const comparison = this.comparePayloads(expectedPayload, incoming.payload, incoming.logTag);

    if (!comparison.match) {
      return this.fail('Payload comparison failed', comparison.differences);
    }

    logger.info('Request validation passed', {
      entry: expectedEntry.toString(),
      comparisonMatch: true
    });

    // Mark entry as processed
    this.validator.advance();
    this.recordSuccess('request_validation', expectedEntry);

    // Forward to destination and validate the actual response
    const response = await this.forwardToDestination(incoming, expectedEntry);
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
      return this.fail('No more entries to process - unexpected response');
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
      return this.fail('Response comparison failed', comparison.differences);
    }

    logger.info('Response validation passed', {
      entry: expectedEntry.toString()
    });

    // Mark entry as processed
    this.validator.advance();
    this.recordSuccess('response_validation', expectedEntry);

    // Trigger next log entry processing (for external source requests like APP->LSP)
    setImmediate(() => {
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
        return this.fail(`No expected response found for skipped destination ${destination}`);
      }

      // Track this pending external request by context for out-of-order matching
      const contextKey = this.getContextKey(expectedEntry);
      this.pendingExternalRequests.set(contextKey, {
        requestEntry: expectedEntry,
        responseEntry: expectedResponse
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

      // Mark both request and response as processed (since we're mocking the external call)
      this.validator.markProcessed(expectedEntry);
      this.validator.markProcessed(expectedResponse);

      // Trigger next log entry processing (for external source requests like APP->LSP)
      // Use setImmediate to let current request handling complete first
      setImmediate(() => {
        this.processNextLogEntry().catch(err => {
          logger.error('Error processing next log entry after skipping destination', { error: err.message });
        });
      });

      return {
        success: true,
        payload: expectedResponse.payload,
        tracked: true
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
        customHeaders
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

        // Try to match with pending
        const handled = this.stateManager.handleIncomingResponse(
          correlationKey,
          serviceResponse.data
        );

        if (handled) {
          // Response was matched with pending request - include headers
          // Continue processing next log entry
          await this.processNextLogEntry();

          return {
            success: true,
            payload: serviceResponse.data,
            headers: serviceResponse.headers
          };
        }
      }

      // Wait for response (handles race condition where response arrives separately)
      const finalResponse = await responsePromise;

      // Get stored headers and include in response
      const storedHeaders = this.stateManager.getResponseHeaders(correlationKey);

      // Validate and mark expected response as processed if not already done
      if (expectedResponse && !this.validator.processedIndices.has(expectedResponse.index)) {
        this.validator.markProcessed(expectedResponse);
        this.recordSuccess('downstream_response_validation', expectedResponse);
      }

      // Continue processing next log entry
      await this.processNextLogEntry();

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
   */
  async handleOutOfOrderRequest(incoming, validation) {
    logger.warn('Handling out-of-order request', {
      expected: validation.expectedEntry?.toString(),
      received: `${incoming.source}→${incoming.destination} ${incoming.logTag}`,
      foundInLookahead: validation.foundInLookahead?.toString()
    });

    // Check if current expected is a request we need to trigger ourselves
    const currentEntry = validation.expectedEntry;

    if (currentEntry?.isRequest && currentEntry.isExternalDestination()) {
      // Current entry is an external call we should mock
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

    return this.fail(`Request out of order. Expected: ${currentEntry?.toString()}`);
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

    for (const [key, value] of this.pendingExternalRequests.entries()) {
      const responseContextKey = this.getContextKey(value.responseEntry);
      if (responseContextKey === contextKey || key === contextKey) {
        matchedEntry = value.requestEntry;
        matchedResponse = value.responseEntry;
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
      return this.fail('External response comparison failed', comparison.differences);
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

    // Continue processing next log entry to trigger subsequent external requests
    await this.processNextLogEntry();

    return {
      success: true,
      payload: matchedResponse.payload
    };
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
  findCorrespondingResponse(requestEntry) {
    // Look for response with reversed source_destination and matching request context
    const direction = `${requestEntry.source}_${requestEntry.destination}`;

    // Search in remaining logs - look ahead further to handle interleaved entries
    const lookahead = this.validator.peekNext(50);

    for (const entry of lookahead) {
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
  fail(error, details = null) {
    this.results.failed++;
    this.results.errors.push({
      error,
      details,
      timestamp: new Date().toISOString()
    });

    logger.error('Replay failed', { error, details });

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
