import { getEndpointConfig, getLenderId } from '../config.js';
import { transformRequest } from '../services/request-transformer.js';
import { makeRequest } from '../services/http-client.js';
import { buildAppCoreAuthHeaders } from '../services/app-core-auth-headers.js';
import { ensureAppCorePreconditions } from '../services/app-core-preconditions.js';
import {
  findAllCorrespondingResponseEntries,
  findCorrespondingResponseEntry,
  matchesRequestContext
} from '../services/response-matcher.js';

function remapReplayIds(value, stateManager) {
  if (!value || typeof value !== 'object') {
    return value;
  }

  if (Array.isArray(value)) {
    return value.map(item => remapReplayIds(item, stateManager));
  }

  const remapped = {};
  const mappedLenderId = getLenderId(value.lender_org_id || value.lenderOrgId);

  for (const [key, nestedValue] of Object.entries(value)) {
    if ((key === 'loanApplicationId' || key === 'loan_application_id') && typeof nestedValue === 'string') {
      remapped[key] = stateManager.getMappedLoanApplicationId(nestedValue);
    } else if (key === 'lenderId' && typeof nestedValue === 'string' && mappedLenderId) {
      remapped[key] = mappedLenderId;
    } else {
      remapped[key] = remapReplayIds(nestedValue, stateManager);
    }
  }

  return remapped;
}

/**
 * LogProcessor - Handles log sequence processing logic extracted from orchestrator.js
 * 
 * Processes log entries sequentially, triggers external requests, and handles
 * internal/external mocking of requests and responses.
 * 
 * Dependencies are injected via constructor for better testability and separation of concerns.
 */
export class LogProcessor {
  /**
   * Create a LogProcessor instance
   * @param {Object} dependencies - Dependencies object
   * @param {Object} dependencies.validator - Log sequence validator instance
   * @param {Object} dependencies.stateManager - State manager instance
   * @param {Object} dependencies.logger - Logger instance
   * @param {Object} dependencies.config - Configuration object
   * @param {Object} dependencies.callbacks - Callbacks object with handler functions
   * @param {Function} dependencies.callbacks.getApiForLogTag - Get API endpoint for log tag
   * @param {Function} dependencies.callbacks.comparePayloads - Compare expected and actual payloads
   * @param {Function} dependencies.callbacks.recordSuccess - Record successful step
   * @param {Function} dependencies.callbacks.recordFailure - Record failed step
   * @param {Function} dependencies.callbacks.fail - Handle failure and stop processing
   * @param {Function} dependencies.callbacks.getServiceBaseUrl - Get service base URL
   * @param {Function} dependencies.callbacks.forwardToDestination - Forward request to destination
   * @param {Function} dependencies.callbacks.processNextLogEntry - Process next log entry (self-reference)
   */
  constructor({ validator, stateManager, logger, config, callbacks }) {
    this.validator = validator;
    this.stateManager = stateManager;
    this.logger = logger;
    this.config = config;
    this.callbacks = callbacks;
    
    // Internal state
    this.isRunning = false;
  }

  /**
   * Set running state
   * @param {boolean} isRunning - Whether the processor is running
   */
  setRunning(isRunning) {
    this.isRunning = isRunning;
  }

  /**
   * Process log entries sequentially, triggering external source requests
   */
  async processNextLogEntry() {
    if (!this.isRunning) return;

    const entry = this.validator.getCurrentEntry();

    this.logger.info('processNextLogEntry called', {
      currentEntry: entry ? entry.toString() : 'none',
      isExternalSource: entry?.isExternalSource(),
      isRequest: entry?.isRequest
    });

    if (!entry) {
      this.logger.info('No more log entries to process');
      return;
    }

    // Handle entries that should be skipped (e.g., WRAPPER entries that weren't filtered)
    if (entry.shouldSkip()) {
      this.logger.info('Skipping entry', { entry: entry.toString() });
      this.validator.markProcessed(entry);
      // Continue to next entry
      if (this.isRunning) {
        setImmediate(() => {
          this.callbacks.processNextLogEntry().catch(err => {
            this.logger.error('Error processing next log entry after skip', { error: err.message });
          });
        });
      }
      return;
    }

    // Handle internal LSP calls (CORE_EULER, CORE_THEMIS) - auto-mock them
    const isInternalLspCall = entry.sourceDestination === 'CORE_EULER' || 
                              entry.sourceDestination === 'CORE_THEMIS' ||
                              (entry.source === 'CORE' && entry.destination === 'EULER') ||
                              (entry.source === 'CORE' && entry.destination === 'THEMIS');
    
    if (isInternalLspCall && entry.isRequest) {
      this.logger.info('Internal LSP call - mocking request/response', {
        entry: entry.toString()
      });
      await this.mockInternalLspRequest(entry);
      return;
    }

    // Sources that orchestrator initiates: APP, LENDER, EULER, THEMIS
    const orchestratorInitiatedSources = ['APP', 'LENDER', 'EULER', 'THEMIS'];
    const shouldOrchestratorInitiate = orchestratorInitiatedSources.includes(entry.source);
    
    // If source is APP/LENDER/EULER/THEMIS, orchestrator triggers the request
    if (shouldOrchestratorInitiate && entry.isRequest) {
      this.logger.info('External source request - triggering from orchestrator', {
        entry: entry.toString(),
        source: entry.source
      });
      await this.triggerExternalRequest(entry);
    } else if (entry.isRequest) {
      // For CORE, GATEWAY, LSP, WRAPPER sources - wait for incoming request
      this.logger.info('Waiting for incoming request from service', {
        entry: entry.toString(),
        source: entry.source,
        destination: entry.destination
      });
      // The actual processing will happen when handleIncomingRequest is called
      // No action needed here - orchestrator waits for HTTP call from the service
    } else {
      this.logger.debug('Not a request entry, skipping trigger', {
        entry: entry.toString()
      });
    }
  }

  /**
   * Trigger a request from external source (APP/LENDER) to internal service
   * @param {Object} entry - Log entry to process
   */
  async triggerExternalRequest(entry) {
    try {
      let api;

      if (entry.isLenderToGwWebhook && entry.isLenderToGwWebhook()) {
        const webhookConfig = getEndpointConfig('LENDER_GW', 'WEBHOOK Request');
        api = webhookConfig?.endpoint || '/gateway/webhook';
        if (entry.lenderOrgId) {
          api = `${api}/${entry.lenderOrgId}`;
        }
      } else {
        api = this.callbacks.getApiForLogTag(entry.logTag);
      }

      const endpointConfig = getEndpointConfig(entry.sourceDestination, entry.logTag);
      const customHeaders = {
        ...(endpointConfig?.headers || {}),
        ...buildAppCoreAuthHeaders(entry, this.validator.entries)
      };
      await ensureAppCorePreconditions(entry, customHeaders);
      const service = endpointConfig?.service || entry.destination;

      const expectedResponses = this.validator.peekNext(100).filter(e => {
        if (!(e.source === entry.destination &&
          e.destination === entry.source &&
          e.isResponse)) {
          return false;
        }
        if (entry.loanApplicationId &&
          e.loanApplicationId !== entry.loanApplicationId) {
          return false;
        }
        if (entry.lenderOrgId && e.lenderOrgId !== entry.lenderOrgId) {
          return false;
        }
        return true;
      });
      const expectedResponse = expectedResponses[0];

      const sourceDestinationForRequest = entry.originalSourceDestination || entry.sourceDestination;

      // Transform masked values in payload before sending
      const remappedPayload = remapReplayIds(entry.payload, this.stateManager);
      const transformedPayload = transformRequest(remappedPayload, entry.logTag);

      // Log API call before making request
      this.logger.logApiCall(entry.source, entry.destination, api, 'REQUEST', entry.index);

      // Log what orchestrator is sending to destination
      this.logger.info('ORCH_SENDING', {
        destination: service,
        baseUrl: this.callbacks.getServiceBaseUrl(service),
        api: api,
        source: entry.source,
        dest: entry.destination,
        logTag: entry.logTag,
        requestId: entry.requestId,
        headers: customHeaders,
        payload: transformedPayload,
        timestamp: new Date().toISOString()
      });

      let response;
      const maxRetries = 10;
      const retryIntervalMs = 5000;

      if (entry.logTag === 'FlipKart-EligibilityStatus_REQUEST') {
        this.logger.info('POLLING_START: Starting polling for FlipKart-EligibilityStatus_REQUEST', {
          logTag: entry.logTag,
          maxRetries,
          retryIntervalMs
        });

        for (let attempt = 1; attempt <= maxRetries; attempt++) {
          this.logger.info(`POLLING_ATTEMPT: Attempt ${attempt}/${maxRetries} for FlipKart-EligibilityStatus_REQUEST`, {
            attempt,
            maxRetries,
            logTag: entry.logTag
          });

      response = await makeRequest(
            this.callbacks.getServiceBaseUrl(service),
            api,
            'POST',
            transformedPayload,
            entry.requestId,
            sourceDestinationForRequest,
            entry.logTag,
            null,
            customHeaders,
            entry.index,
            this.callbacks.getServiceUnixSocket(service)
          );

          let responseData = response?.data;
          if (typeof responseData === 'string') {
            try {
              responseData = JSON.parse(responseData);
            } catch (e) {
              this.logger.warn('Failed to parse response data as JSON', { error: e.message });
            }
          }

          const hasSuccess = responseData?.status === 'SUCCESS';
          const hasLenderEligibilities = responseData?.lender_eligibilities && 
                                         Array.isArray(responseData.lender_eligibilities) && 
                                         responseData.lender_eligibilities.length > 0;

          this.logger.info(`POLLING_CHECK: Attempt ${attempt} response check`, {
            attempt,
            hasSuccess,
            hasLenderEligibilities,
            statusValue: responseData?.status,
            lenderEligibilitiesCount: responseData?.lender_eligibilities?.length || 0,
            dataType: typeof response?.data
          });

          if (hasSuccess && hasLenderEligibilities) {
            this.logger.info('POLLING_SUCCESS: Received success and lender_eligibilities', {
              attempt,
              lenderEligibilitiesCount: responseData.lender_eligibilities.length
            });
            response.data = responseData;
            break;
          }

          if (attempt < maxRetries) {
            this.logger.info(`POLLING_RETRY: Waiting ${retryIntervalMs}ms before retry`, {
              attempt,
              nextAttempt: attempt + 1,
              waitMs: retryIntervalMs
            });
            await new Promise(resolve => setTimeout(resolve, retryIntervalMs));
          } else {
            this.logger.error('POLLING_FAILED: Max retries reached without success and lender_eligibilities', {
              attempts: maxRetries,
              lastResponse: response?.data
            });
            throw new Error(`Did not get response with success and lender_eligibilities from FlipKart-EligibilityStatus_REQUEST after ${maxRetries} attempts`);
          }
        }
      } else {
        if (entry.logTag === 'FlipKart-CreateLoan_REQUEST') {
          this.logger.info('Adding 1s delay before FlipKart-CreateLoan_REQUEST', {
            logTag: entry.logTag,
            delayMs: 1000
          });
          await new Promise(resolve => setTimeout(resolve, 1000));
        }
        response = await makeRequest(
          this.callbacks.getServiceBaseUrl(service),
          api,
          'POST',
          transformedPayload,
          entry.requestId,
          sourceDestinationForRequest,
          entry.logTag,
          null,
          customHeaders,
          entry.index,
          this.callbacks.getServiceUnixSocket(service)
        );
      }

      // Log detailed response
      this.logger.info('=== RESPONSE RECEIVED FROM DESTINATION ===', {
        service: service,
        baseUrl: this.callbacks.getServiceBaseUrl(service),
        api: api,
        status: response?.status,
        statusText: response?.statusText,
        hasData: !!response?.data,
        dataKeys: response?.data ? Object.keys(response.data) : [],
        hasError: !!response?.error,
        errorMessage: response?.error ? response.message : null,
        requestId: entry.requestId,
        timestamp: new Date().toISOString()
      });

      // Log API response
      if (expectedResponse) {
        this.logger.logApiCall(entry.destination, entry.source, api, 'RESPONSE', expectedResponse.index);
      }

      // Compare response with expected
      if (expectedResponse) {
        const comparison = this.callbacks.comparePayloads(
          expectedResponse.payload,
          response.data,
          expectedResponse.logTag
        );

        if (!comparison.match) {
          this.callbacks.recordFailure('external_response_comparison', entry, comparison.differences);
          throw new Error(`Payload comparison failed: ${JSON.stringify(comparison.differences)}`);
        } else {
          this.logger.info('External request response validated', {
            request: entry.toString(),
            response: expectedResponse.toString(),
            actualResponse: response.data
          });
          this.callbacks.recordSuccess('external_response_validation', expectedResponse);
        }

        // Mark request as processed
        this.validator.advance(); // request
        
        // Mark ALL matching responses as processed (handles duplicates)
        for (const response of expectedResponses) {
          this.validator.markProcessed(response);
        }
      } else {
        this.validator.advance();
      }

      // Continue to next entry
      await this.callbacks.processNextLogEntry();

    } catch (error) {
      this.logger.error('Failed to trigger external request', {
        entry: entry.toString(),
        error: error.message
      });
      this.callbacks.recordFailure('external_request_trigger', entry, error.message);
    }
  }

  /**
   * Get API endpoint for a log tag
   * Delegates to callback
   * @param {string} logTag - Log tag to get API for
   * @returns {string} API endpoint
   */
  getApiForLogTag(logTag) {
    return this.callbacks.getApiForLogTag(logTag) || '/api/unknown';
  }

  /**
   * Mock an external request (e.g., LENDER callback/webhook)
   * @param {Object} expectedEntry - Expected log entry to mock
   */
  async mockExternalRequest(expectedEntry) {
    this.logger.info('Mocking external request', {
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

    this.logger.info('External request mocked successfully', {
      request: expectedEntry.toString(),
      response: responseEntry.toString()
    });
  }

  /**
   * Mock an internal LSP→LSP request
   * Internal LSP calls don't go through the orchestrator's HTTP endpoints,
   * so we simulate them by marking both request and response as processed
   * @param {Object} expectedEntry - Expected log entry to mock
   */
  async mockInternalLspRequest(expectedEntry) {
    this.logger.info('Mocking internal LSP request', {
      entry: expectedEntry.toString()
    });

    // Find ALL corresponding responses (there may be duplicates)
    const responseEntries = this.findAllCorrespondingResponses(expectedEntry);

    if (responseEntries.length === 0) {
      throw new Error(`No corresponding response found for internal LSP call ${expectedEntry.toString()}`);
    }

    // Mark request as processed
    this.validator.markProcessed(expectedEntry);
    
    // Mark ALL response entries as processed (handles duplicate responses)
    for (const responseEntry of responseEntries) {
      this.validator.markProcessed(responseEntry);
    }

    // Record success
    this.callbacks.recordSuccess('internal_request_mocked', expectedEntry);
    for (const responseEntry of responseEntries) {
      this.callbacks.recordSuccess('internal_response_mocked', responseEntry);
    }

    this.logger.info('Internal LSP request mocked successfully', {
      request: expectedEntry.toString(),
      requestIndex: expectedEntry.index,
      responsesFound: responseEntries.length,
      responses: responseEntries.map(e => ({str: e.toString(), index: e.index}))
    });

    // Trigger next log entry processing after internal mock completes
    if (this.isRunning) {
      setImmediate(() => {
        this.callbacks.processNextLogEntry().catch(err => {
          this.logger.error('Error processing next log entry after internal LSP mock', { error: err.message });
        });
      });
    }
  }

  /**
   * Find corresponding response for a request entry
   * @param {Object} requestEntry - Request log entry
   * @param {boolean} searchAll - Whether to search all entries including processed ones
   * @returns {Object|null} Response entry or null
   */
  findCorrespondingResponse(requestEntry, searchAll = false) {
    return findCorrespondingResponseEntry(this.validator.entries, requestEntry, {
      searchAll,
      processedIndices: this.validator.processedIndices
    });
  }

  /**
   * Find ALL response entries corresponding to a request (handles duplicate responses)
   * @param {Object} requestEntry - Request log entry
   * @returns {Array} Array of matching response entries
   */
  findAllCorrespondingResponses(requestEntry) {
    return findAllCorrespondingResponseEntries(this.validator.entries, requestEntry, {
      searchAll: true,
      processedIndices: this.validator.processedIndices
    });
  }

  /**
   * Check if response matches request context (loan application ID, etc.)
   * @param {Object} requestEntry - Request log entry
   * @param {Object} responseEntry - Response log entry
   * @returns {boolean} Whether entries match
   */
  matchesRequestContext(requestEntry, responseEntry) {
    return matchesRequestContext(requestEntry, responseEntry);
  }
}

export default LogProcessor;
