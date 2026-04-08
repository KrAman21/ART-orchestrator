import { StateManager } from './services/state-manager.js';
import { LogSequenceValidator, LogEntry } from './services/log-sequence-validator.js';
import { makeRequest } from './services/http-client.js';
import { compareLog } from './services/comparator.js';
import { logger } from './utils/logger.js';
import { extractPayload } from './config.js';

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

    this.isRunning = false;
  }

  /**
   * Start the replay session
   */
  async start() {
    this.isRunning = true;
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

      // Make request to destination service (LSP or GW)
      const response = await makeRequest(
        this.getServiceBaseUrl(service),
        api,
        'POST',
        entry.payload,
        entry.requestId,
        entry.sourceDestination,
        entry.logTag,
        null
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
            response: expectedResponse.toString()
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
   */
  getApiForLogTag(logTag) {
    // Map log tags to API endpoints
    const mappings = {
      'POLLING API Request': '/api/polling',
      'SUBMIT_APPLICATION': '/api/applications',
      'STATUS_CHECK': '/api/status',
      'LENDER_RESPONSE': '/api/callback/lender',
      'STATUS_CALLBACK': '/api/callback/status'
    };
    return mappings[logTag] || '/api/unknown';
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
      requestId: incoming.requestId
    });

    // Handle case where we're expecting a response but got a request
    // (Response might have arrived early and been buffered)
    if (validation.isEarly) {
      logger.debug('Got request when expecting response, checking buffers', {
        expected: expectedEntry.toString(),
        received: `${incoming.source}→${incoming.destination} ${incoming.logTag}`
      });
    }

    // If validation failed, check if we need to handle out-of-order scenarios
    if (!validation.valid && validation.foundInLookahead) {
      // There's a mismatch - we might have a webhook or intermediate call
      return await this.handleOutOfOrderRequest(incoming, validation);
    }

    if (!validation.valid) {
      return this.fail(validation.error);
    }

    // Validation passed - compare payloads
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

    // Determine next action based on destination
    if (expectedEntry.isExternalDestination()) {
      // External destination - we need to mock the response
      logger.info('External destination, mocking response', {
        destination: expectedEntry.destination
      });

      // Return the expected response from the next log entry
      const mockResponse = await this.getExpectedResponse(expectedEntry);
      return mockResponse;
    }

    // Forward to actual destination service
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

    return {
      success: true,
      payload: incomingResponse.payload
    };
  }

  /**
   * Forward validated request to actual destination service
   */
  async forwardToDestination(incoming, expectedEntry) {
    const destination = expectedEntry.destination;
    const api = incoming.api;

    logger.info('Forwarding to destination', {
      destination,
      api,
      requestId: incoming.requestId
    });

    try {
      // Generate correlation key for tracking
      const correlationKey = StateManager.generateCorrelationKey(
        api,
        expectedEntry.sourceDestination,
        incoming.requestId
      );

      // Register pending request (for response matching)
      const responsePromise = this.stateManager.registerPendingRequest(
        correlationKey,
        this.validator.peekNext(1)[0] // Next entry should be the response
      );

      // Make actual HTTP request to destination
      // This would use the http-client with actual endpoint mapping
      const serviceResponse = await makeRequest(
        this.getServiceBaseUrl(destination),
        api,
        'POST', // Method should come from config
        incoming.payload,
        incoming.requestId,
        expectedEntry.sourceDestination,
        expectedEntry.logTag,
        null // merchantId
      );

      // If response came synchronously, handle it
      if (serviceResponse && !serviceResponse.error) {
        // Try to match with pending
        const handled = this.stateManager.handleIncomingResponse(
          correlationKey,
          serviceResponse.data
        );

        if (handled) {
          // Response was matched with pending request
          return serviceResponse.data;
        }
      }

      // Wait for response (handles race condition where response arrives separately)
      const finalResponse = await responsePromise;

      return finalResponse;

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
   * Get expected response for a given request from logs
   */
  async getExpectedResponse(requestEntry) {
    const responseEntry = this.findCorrespondingResponse(requestEntry);

    if (!responseEntry) {
      throw new Error(`No response found for request ${requestEntry.toString()}`);
    }

    // Mark response as processed
    this.validator.markProcessed(responseEntry);

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
    const reversedDirection = `${requestEntry.destination}_${requestEntry.source}`;

    // Search in remaining logs
    const lookahead = this.validator.peekNext(10);

    for (const entry of lookahead) {
      if (
        entry.isResponse &&
        entry.sourceDestination === reversedDirection &&
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
      responseEntry.loanApplicationId
    ) {
      return requestEntry.loanApplicationId === responseEntry.loanApplicationId;
    }

    // Match by request_id if present
    if (requestEntry.requestId && responseEntry.requestId) {
      // In real traces, response might have related request_id
      return true; // Simplified - should check actual relationship
    }

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
    return urls[serviceName];
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
