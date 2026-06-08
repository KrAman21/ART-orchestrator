import { ReplayOrchestrator } from '../orchestrator.js';
import { BufferManager } from './buffer-manager.js';
import { NonBlockingHttpClient } from './non-blocking-http.js';
import { logger } from '../utils/logger.js';
import { transformRequest } from '../services/request-transformer.js';
import { getEndpointConfig, getLenderId, normalizeSourceDestination, RETRY_TIMEOUT_OVERRIDES } from '../config.js';
import { isThemisEligibilitySpecialCase, isThemisKfsSpecialCase } from '../replay-special-cases.js';
import { buildAppCoreAuthHeaders } from '../services/app-core-auth-headers.js';
import { ensureAppCorePreconditions } from '../services/app-core-preconditions.js';

function resolveWrapperEndpointForMerchant(entry, endpointConfig) {
  if (!entry || entry.sourceDestination !== 'APP_WRAPPER') {
    return endpointConfig?.endpoint || null;
  }

  const merchantId = entry.message?.merchant_id;
  const merchantSpecificEndpoints = {
    flipkart: {
      'FlipKart-FetchStatus_REQUEST': '/flipkart/fetch/status',
      'FlipKart-OrderStatus_REQUEST': '/flipkart/order/status',
      'FlipKart-Refund_REQUEST': '/flipkart/refund',
      'FlipKart-GetKFS_REQUEST': '/flipkart/getKFS'
    },
    flipkartSM: {
      'FlipKart-FetchStatus_REQUEST': '/flipkartSM/fetch/status',
      'FlipKart-OrderStatus_REQUEST': '/flipkartSM/order/status',
      'FlipKart-Refund_REQUEST': '/flipkartSM/refund'
    },
    flipkart2w: {
      'FlipKart-GetKFS_REQUEST': '/flipkart2w/getKFS'
    }
  };

  return merchantSpecificEndpoints[merchantId]?.[entry.logTag] || endpointConfig?.endpoint || null;
}

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

function buildSyntheticThemisIneligibleResponse(lenderOrgId) {
  return {
    lenderOrgId,
    lenderOrgId,
    isNTC: true,
    lowerEligibleLimit: null,
    upperEligibleLimit: null,
    lenderKfsDetails: null,
    lenderDashboardOffer: null,
    eligibilityExpiry: null,
    ruleType: 'INTERNAL',
    isEligible: false,
    metaData: {
      ruleVersion: 'ART_SYNTHETIC',
      trace: [[{
        name: 'ART replay synthetic fallback',
        ruleId: 'ART_FALLBACK',
        result: 'false',
        errorCode: 'ART_NO_MATCHING_REPLAY_RESPONSE',
        lenderOrgId
      }]]
    }
  };
}

export class AsyncReplayOrchestrator extends ReplayOrchestrator {
  constructor(logs, config = {}) {
    super(logs, config);
    
    this.bufferManager = new BufferManager({
      defaultTimeoutMs: 60000
    });
    
    this.httpClient = new NonBlockingHttpClient(
      this.bufferManager,
      config.reportGenerator,
      config.orderId,
      {
        shouldTreatApiFailureAsExpected: this.shouldTreatApiFailureAsExpected.bind(this)
      }
    );
    
    this.isPolling = false;
    this.pollIntervalMs = config.pollIntervalMs || 800;
    this.shouldStop = false;
    this.orderId = config.orderId;
  }
  
  async start() {
    if (this.isRunning) {
      logger.warn('Async orchestrator already running');
      return { success: false, message: 'Already running' };
    }
    
    this.isRunning = true;
    this.shouldStop = false;
    
    const { merchantId, orderId } = AsyncReplayOrchestrator.extractMerchantId(this.logs);
    const lenderOrgIdToIdMap = AsyncReplayOrchestrator.extractLenderOrgIds(this.logs);
    const lineDetails = AsyncReplayOrchestrator.extractLineDetails(this.logs);
    const customerSeedData = AsyncReplayOrchestrator.extractCustomerSeedData(this.logs);
    const lineSeedData = AsyncReplayOrchestrator.extractLineSeedData(this.logs);

    await this.clearLspData(merchantId, orderId);
    await this.onboardSeedData(
      merchantId,
      lenderOrgIdToIdMap,
      lineDetails,
      customerSeedData,
      lineSeedData
    );
    
    logger.info('Async replay orchestrator started', {
      totalLogs: this.logs.length,
      validator: this.validator.getProgress()
    });
    
    this.pollingLoop();
    
    return {
      success: true,
      message: 'Async orchestrator started'
    };
  }
  
  async pollingLoop() {
    this.isPolling = true;
    let consecutiveNoWork = 0;
    const maxBackoffMs = 1000;
    
    while (this.isRunning && !this.shouldStop) {
      try {
        const didWork = await this.processOneCycle();
        
        if (!didWork) {
          consecutiveNoWork++;
          const backoffMs = Math.min(this.pollIntervalMs * Math.pow(1.5, consecutiveNoWork), maxBackoffMs);
          await this.sleep(backoffMs);
        } else {
          consecutiveNoWork = 0;
        }
        
        if (this.validator.isComplete()) {
          logger.info('All logs processed');
          break;
        }
      } catch (error) {
        logger.error('Error in polling loop', { error: error.message });
        await this.sleep(this.pollIntervalMs);
      }
    }
    
    this.isPolling = false;
    logger.info('Polling loop ended');
  }
  
  async processOneCycle() {
    let didWork = false;
    
    didWork = await this.checkBufferedResponses() || didWork;
    didWork = await this.processNextLogEntry() || didWork;
    
    return didWork;
  }
  
  async checkBufferedResponses() {
    const currentEntry = this.validator.getCurrentEntry();
    
    if (!currentEntry || !currentEntry.isResponse) {
      return false;
    }
    
    // Find the corresponding request entry (should be the previous unprocessed request)
    const requestEntry = this.findCorrespondingRequest(currentEntry);
    if (!requestEntry) {
      logger.debug('No corresponding request found for response', {
        responseEntry: currentEntry.toString()
      });
      return false;
    }

    // Core replay contract for GATEWAY->LENDER:
    // once the live _REQUEST has been buffered, matched, and validated, the later
    // _RESPONSE step must be served from replay logs when sequence reaches it.
    // It should not depend on a second live lender response arriving in ART.
    if (
      requestEntry.source === 'GATEWAY' &&
      requestEntry.destination === 'LENDER' &&
      currentEntry.source === 'LENDER' &&
      currentEntry.destination === 'GATEWAY' &&
      this.validator.processedIndices.has(requestEntry.index)
    ) {
      const responseContextKey = this.getContextKey(currentEntry);
      const requestContextKey = this.getContextKey(requestEntry);
      const contextKey = this.pendingExternalRequests.has(responseContextKey)
        ? responseContextKey
        : requestContextKey;
      const pendingExternal = this.pendingExternalRequests.get(contextKey);

      if (pendingExternal) {
        clearTimeout(pendingExternal.timeoutHandle);
        this.pendingExternalRequests.delete(contextKey);
        pendingExternal.resolve({
          success: true,
          payload: transformRequest(currentEntry.payload, currentEntry.logTag)
        });
      }

      const postResponseWebhooks = this.pendingPostResponseWebhooks?.get(contextKey);
      if (postResponseWebhooks?.length) {
        logger.info('Triggering queued post-response webhook(s) for replayed GATEWAY->LENDER response', {
          contextKey,
          webhookCount: postResponseWebhooks.length,
          entry: currentEntry.toString()
        });
        await this.triggerWebhooks(postResponseWebhooks);
        this.pendingPostResponseWebhooks.delete(contextKey);
      }

      this.validator.advance();
      this.recordSuccess('gateway_lender_response_replay', currentEntry);

      logger.info('Replayed GATEWAY->LENDER response directly from logs', {
        requestEntry: requestEntry.toString(),
        responseEntry: currentEntry.toString(),
        responseContextKey,
        requestContextKey,
        resolvedContextKey: contextKey
      });

      return true;
    }
    
    // Use the request's requestId to lookup in buffer
    const requestId = requestEntry.requestId;
    if (!requestId) {
      return false;
    }
    
    let buffered = this.bufferManager.getResponse(requestId);
    
    // Fallback: look up by metadata when requestId mismatch occurs
    if (!buffered) {
      buffered = this.bufferManager.getResponseByMetadata(
        currentEntry.logTag,
        currentEntry.sourceDestination,
        currentEntry.loanApplicationId,
        currentEntry.lenderOrgId
      );
    }
    
    if (!buffered) {
      logger.debug('Response not yet in buffer', {
        requestId,
        responseEntry: currentEntry.toString()
      });
      return false;
    }
    
    logger.info('Found buffered response for current entry', {
      entry: currentEntry.toString(),
      requestId,
      requestEntry: requestEntry.toString()
    });
    
    if (buffered.isError) {
      const r = buffered.response;
      // API failure: error is inside response.data.error.error_message
      const apiErr = r?.data?.error || r?.data?.Error;
      const errorMsg = apiErr?.error_message
        || apiErr?.message
        || r?.data?.error_message
        || r?.message
        || 'Unknown error';
      await this.fail(`API Failure: ${errorMsg}`);
      return true;
    }
    
    const comparison = this.comparePayloads(
      currentEntry.payload,
      buffered.response.data,
      currentEntry.logTag
    );
    
    if (!comparison.match) {
      logger.warn('Buffered response comparison mismatch tolerated', {
        entry: currentEntry.toString(),
        logTag: currentEntry.logTag,
        differences: comparison.differences
      });
    }

    this.recordObservedProcessedResponse(currentEntry, buffered.response.data);
    
    this.validator.advance();
    this.recordSuccess('buffered_response_validation', currentEntry);
    
    logger.info('Buffered response validated and processed', {
      entry: currentEntry.toString()
    });
    
    return true;
  }
  
  async processNextLogEntry() {
    const entry = this.validator.getCurrentEntry();
    
    if (!entry) {
      return false;
    }
    
    // Skip already processed entries (e.g., GATEWAY->LENDER handled immediately)
    if (this.validator.processedIndices.has(entry.index)) {
      logger.debug('Entry already processed, skipping', {
        entry: entry.toString()
      });
      this.validator.advance();
      return true;
    }
    
    if (entry.shouldSkip()) {
      this.validator.markProcessed(entry);
      return true;
    }
    
    const isInternalLspCall = entry.sourceDestination === 'CORE_EULER' ||
                              entry.sourceDestination === 'CORE_THEMIS' ||
                              (entry.source === 'CORE' && entry.destination === 'EULER') ||
                              (entry.source === 'CORE' && entry.destination === 'THEMIS');
    
    if (isInternalLspCall && entry.isRequest) {
      await this.mockInternalLspRequest(entry);
      return true;
    }
    const orchestratorInitiatedSources = ['APP', 'LENDER', 'EULER', 'THEMIS'];
    const shouldOrchestratorInitiate = orchestratorInitiatedSources.includes(entry.source) ||
      (entry.source === 'CORE' && entry.destination === 'GATEWAY' && entry.logTag === 'LSP-FetchOfferSync_REQUEST');
    
    if (shouldOrchestratorInitiate && entry.isRequest) {
      await this.triggerExternalRequestAsync(entry);
      return true;
    } else if (entry.isRequest) {
      const effectiveTimeoutMs = this.getRequestWaitTimeoutMs(entry);

      logger.info('Replay thread waiting for incoming request', {
        entry: entry.toString(),
        timeoutMs: effectiveTimeoutMs
      });

      const buffered = await this.bufferManager.waitForMatchingRequest(
        entry,
        effectiveTimeoutMs
      );

      if (!buffered) {
        // Check if the entry was mocked/processed externally (e.g. via mockExternalRequest)
        // while the replay thread was waiting — treat this as a handled skip, not a failure
        if (this.validator.processedIndices.has(entry.index)) {
          logger.info('Entry was mocked externally while waiting, advancing past it', {
            entry: entry.toString(),
            currentIndex: this.validator.currentIndex
          });

          // `markProcessed(entry)` may already have advanced currentIndex past this entry
          // (for example, when an optional-repeat skip resolves the waiter). Advancing
          // again here would incorrectly skip the next replay entry.
          if (this.validator.currentIndex === entry.index) {
            this.validator.advance();
          }
          return true;
        }
        const message = `Replay mismatch: timed out waiting for ${entry.toString()}`;
        logger.error('Replay request mismatch', {
          entry: entry.toString(),
          timeoutMs: effectiveTimeoutMs
        });
        this.recordFailure('request_replay_timeout', entry, message);
        await this.fail(message);
        return true;
      }

      try {
        const response = await super.handleIncomingRequest(buffered.request);
        this.bufferManager.completeIncomingRequest(buffered.key, response);
        return true;
      } catch (error) {
        this.bufferManager.failIncomingRequest(buffered.key, error);
        throw error;
      }
    }
    
    if (entry.isResponse) {
      logger.debug('Current entry is a response, waiting for it to arrive via buffer', {
        entry: entry.toString()
      });
      return false;
    }
    
    return false;
  }

  getRequestWaitTimeoutMs(entry) {
    const baseTimeoutMs = this.config.timeoutMs;
    const perLogTagOverrideMs = RETRY_TIMEOUT_OVERRIDES[entry.logTag]
      ? RETRY_TIMEOUT_OVERRIDES[entry.logTag] * 1000
      : 0;
    const isGatewayToLender = entry.source === 'GATEWAY' && entry.destination === 'LENDER';
    const gatewayToLenderTimeoutMs = isGatewayToLender ? baseTimeoutMs * 5 : baseTimeoutMs;

    return Math.max(baseTimeoutMs, gatewayToLenderTimeoutMs, perLogTagOverrideMs);
  }
  
  async triggerExternalRequestAsync(entry) {
    try {
      const endpointConfig = getEndpointConfig(entry.sourceDestination, entry.logTag);
      const resolvedEndpoint = resolveWrapperEndpointForMerchant(entry, endpointConfig);
      const api = resolvedEndpoint || this.getApiForLogTag(entry.logTag);
      const customHeaders = {
        ...(endpointConfig?.headers || {}),
        ...buildAppCoreAuthHeaders(entry, this.validator.entries)
      };
      await ensureAppCorePreconditions(entry, customHeaders);
      const service = endpointConfig?.service || entry.destination;
      
      const remappedPayload = remapReplayIds(entry.payload, this.stateManager);
      const transformedPayload = transformRequest(remappedPayload, entry.logTag);
      
      logger.info('ORCH_SENDING_ASYNC', {
        destination: service,
        api,
        logTag: entry.logTag,
        requestId: entry.requestId
      });
      
      this.httpClient.send(
        this.getServiceBaseUrl(service),
        api,
        'POST',
        transformedPayload,
        entry.requestId,
        entry.sourceDestination,
        entry.logTag,
        null,
        customHeaders,
        entry.index,
        this.getServiceUnixSocket(service),
        entry.loanApplicationId,
        entry.lenderOrgId
      );

      logger.logOutgoing(entry.source, entry.destination, api, transformedPayload, {
        requestId: entry.requestId,
        logTag: entry.logTag,
        sourceDestination: entry.sourceDestination
      });
      
      this.validator.advance();
      
      logger.info('Async request sent, main thread continuing', {
        requestId: entry.requestId,
        logTag: entry.logTag
      });
      
    } catch (error) {
      logger.error('Failed to trigger async external request', {
        entry: entry.toString(),
        error: error.message
      });
      this.recordFailure('async_external_request_trigger', entry, error.message);
      await this.fail('Failed to trigger async external request for ' + entry.logTag + ': ' + error.message);
    }
  }

  shouldTreatApiFailureAsExpected(activeReq, response, apiFailure) {
    if (!activeReq?.logIndex) {
      return false;
    }

    const requestEntry = this.validator.entries.find(entry => entry.index === activeReq.logIndex);
    if (!requestEntry) {
      return false;
    }

    const expectedResponse = this.findCorrespondingResponse(requestEntry, true);
    if (!expectedResponse?.payload) {
      return false;
    }

    const expectedPayload = expectedResponse.payload;
    const expectedStatus = expectedPayload.status || expectedPayload.Status || null;
    const expectedError =
      expectedPayload.error?.error_message ||
      expectedPayload.error?.message ||
      expectedPayload.errorMessage ||
      expectedPayload.message ||
      null;
    const expectedErrorCode =
      expectedPayload.error?.error_code ||
      expectedPayload.error?.code ||
      expectedPayload.errorCode ||
      null;

    const actualError =
      apiFailure?.error_message ||
      apiFailure?.message ||
      apiFailure?.description ||
      null;
    const actualErrorCode =
      apiFailure?.error_code ||
      apiFailure?.code ||
      null;

    const matchesExpectedFailure =
      expectedStatus === 'FAILURE' &&
      (
        (expectedError && actualError && expectedError === actualError) ||
        (expectedErrorCode && actualErrorCode && expectedErrorCode === actualErrorCode)
      );

    if (matchesExpectedFailure) {
      logger.info('Treating API failure as expected replay response', {
        requestId: activeReq.requestId || null,
        logTag: activeReq.logTag,
        logIndex: activeReq.logIndex,
        expectedResponse: expectedResponse.toString(),
        expectedError,
        expectedErrorCode,
        actualError,
        actualErrorCode
      });
    }

    return matchesExpectedFailure;
  }
  
  async replayGatewayLenderPair(entry) {
    const responseEntries = this.findAllCorrespondingResponses(entry);

    if (!responseEntries.length) {
      await this.fail('No corresponding response found for ' + entry.logTag);
      return;
    }

    this.validator.processedIndices.add(entry.index);
    this.recordSuccess('gateway_lender_request_replay', entry);

    for (const responseEntry of responseEntries) {
      this.validator.processedIndices.add(responseEntry.index);
      this.recordSuccess('gateway_lender_response_replay', responseEntry);
    }

    this.validator.advance();

    logger.info('Replayed GATEWAY->LENDER request/response pair directly', {
      requestIndex: entry.index,
      responseIndices: responseEntries.map(responseEntry => responseEntry.index),
      responseCount: responseEntries.length,
      logTag: entry.logTag
    });
  }

  async handleIncomingRequest(incoming) {
    if (!this.isRunning) {
      throw new Error('Orchestrator not running');
    }

    this.recordObservedIncomingRequest(incoming);

    logger.info('ASYNC_ORCH_RECEIVING', {
      source: incoming.source,
      destination: incoming.destination,
      api: incoming.api,
      requestId: incoming.requestId,
      logTag: incoming.logTag,
      lenderOrgId: incoming.lenderOrgId
    });

    if (isThemisEligibilitySpecialCase(incoming.logTag) && incoming.source === 'GATEWAY' &&
        (incoming.destination === 'LENDER' || incoming.destination === 'LSP' || incoming.destination === 'THEMIS')) {
      logger.logIncoming(incoming.source, incoming.destination, incoming.api, incoming.payload, {
        requestId: incoming.requestId,
        logTag: incoming.logTag,
        lenderOrgId: incoming.lenderOrgId,
        handler: 'ThemisEligibilityBatchAsync'
      });
      return await this.handleThemisEligibilityBatchAsync(incoming);
    }

    if (isThemisKfsSpecialCase(incoming.logTag) && incoming.source === 'GATEWAY' &&
        (incoming.destination === 'LENDER' || incoming.destination === 'LSP' || incoming.destination === 'THEMIS')) {
      logger.logIncoming(incoming.source, incoming.destination, incoming.api, incoming.payload, {
        requestId: incoming.requestId,
        logTag: incoming.logTag,
        lenderOrgId: incoming.lenderOrgId,
        handler: 'ThemisKFSBatchAsync'
      });
      return await this.handleThemisKFSBatchAsync(incoming);
    }

    logger.logIncoming(incoming.source, incoming.destination, incoming.api, incoming.payload, {
      requestId: incoming.requestId,
      logTag: incoming.logTag,
      handler: 'BufferManager'
    });

    const syntheticCompatibilityResponse = this.maybeHandleSyntheticFibeGenerateToken(incoming);
    if (syntheticCompatibilityResponse) {
      logger.info('Handled incoming request with synthetic compatibility response', {
        source: incoming.source,
        destination: incoming.destination,
        logTag: incoming.logTag,
        lenderOrgId: incoming.lenderOrgId,
        requestId: incoming.requestId
      });
      return syntheticCompatibilityResponse;
    }

    const syntheticCheckoutStatusResponse = this.maybeHandleSyntheticFibeCheckoutStatus(incoming);
    if (syntheticCheckoutStatusResponse) {
      logger.info('Handled FIBE checkout status with synthetic compatibility response', {
        source: incoming.source,
        destination: incoming.destination,
        logTag: incoming.logTag,
        lenderOrgId: incoming.lenderOrgId,
        requestId: incoming.requestId
      });
      return syntheticCheckoutStatusResponse;
    }

    const loanApplicationDataResponse = await this.maybePassThroughFetchLoanApplicationData(incoming);
    if (loanApplicationDataResponse) {
      logger.info('Handled fetchLoanApplicationData with LSP pass-through response', {
        source: incoming.source,
        destination: incoming.destination,
        logTag: incoming.logTag,
        requestId: incoming.requestId
      });
      return loanApplicationDataResponse;
    }

    const directGatewayLenderResponse = await this.maybeHandleCurrentGatewayLenderRequest(incoming);
    if (directGatewayLenderResponse) {
      return directGatewayLenderResponse;
    }
    
    // Let retry detection run before buffering.
    // Some lender callbacks legitimately repeat requests that were already
    // satisfied from replay logs, and those should reuse the cached response.
    const retryResult = this.retryHandler.handleRetryRequest(incoming);
    if (retryResult) {
      logger.info('Handled retried request asynchronously', {
        source: incoming.source,
        destination: incoming.destination,
        api: incoming.api,
        logTag: incoming.logTag
      });
      return retryResult;
    }

    const sourceDestination = normalizeSourceDestination(
      `${incoming.source}_${incoming.destination}`,
      incoming.logTag
    );
    const parts = sourceDestination.split('_');
    const normalizedIncoming = {
      ...incoming,
      source: parts[0],
      destination: parts[1]
    };

    // If replay is already complete, ignore late straggler requests gracefully
    if (this.validator.isComplete()) {
      logger.warn('Ignoring late straggler request after replay completion', {
        source: incoming.source,
        destination: incoming.destination,
        logTag: incoming.logTag
      });
      return { success: true, ignored: true };
    }

    const buffered = await this.bufferManager.addIncomingRequest(normalizedIncoming);
    
    logger.info('Request buffered for async processing', {
      requestId: normalizedIncoming.requestId,
      bufferKey: buffered.key
    });
    
    try {
      const result = await buffered.deferred.promise;
      return result;
    } catch (error) {
      logger.error('Buffered request failed', { error: error.message });
      return {
        success: false,
        error: error.message
      };
    }
  }

  async maybeHandleCurrentGatewayLenderRequest(incoming) {
    const sourceDestination = normalizeSourceDestination(
      `${incoming.source}_${incoming.destination}`,
      incoming.logTag
    );
    const [source, destination] = sourceDestination.split('_');

    if (source !== 'GATEWAY' || destination !== 'LENDER') {
      return null;
    }

    const currentEntry = this.validator.getCurrentEntry();
    if (
      !currentEntry?.isRequest ||
      currentEntry.source !== 'GATEWAY' ||
      currentEntry.destination !== 'LENDER'
    ) {
      return null;
    }

    const normalizedIncoming = {
      ...incoming,
      source,
      destination
    };

    if (!this.validator.matchesExpected(currentEntry, normalizedIncoming)) {
      return null;
    }

    logger.info('Processing current GATEWAY->LENDER request immediately to unblock nested gateway call', {
      entry: currentEntry.toString(),
      requestId: incoming.requestId,
      logTag: incoming.logTag,
      lenderOrgId: incoming.lenderOrgId
    });

    const response = await super.handleIncomingRequest(incoming);

    // The replay loop may already be blocked on waitForMatchingRequest for this
    // exact entry. Since we handled it synchronously here, release that waiter
    // so ART does not time out on a request that was already processed.
    this.bufferManager?.skipWaiter?.(currentEntry);

    return response;
  }
  
  async handleThemisEligibilityBatchAsync(incoming) {
    logger.info('Processing Themis-Eligibility batch asynchronously', {
      lenderOrgId: incoming.lenderOrgId,
      requestId: incoming.requestId
    });
    
    // Find the matching request and response entries by lenderOrgId
    const allThemisEntries = this.validator.entries.filter(entry =>
      entry.logTag === 'Themis-Eligibility_REQUEST' &&
      entry.source === 'GATEWAY' &&
      (entry.destination === 'LENDER' || entry.destination === 'LSP' || entry.destination === 'THEMIS') &&
      !this.validator.processedIndices.has(entry.index)
    );
    
    let requestEntry = null;
    let responseEntry = null;
    
    for (const entry of allThemisEntries) {
      if (entry.lenderOrgId === incoming.lenderOrgId) {
        requestEntry = entry;
        responseEntry = this.validator.entries.find(e =>
          e.logTag === 'Themis-Eligibility_RESPONSE' &&
          (e.sourceDestination === 'GATEWAY_THEMIS' || e.sourceDestination === 'GATEWAY_LSP' || e.sourceDestination === 'GATEWAY_LENDER') &&
          e.lenderOrgId === incoming.lenderOrgId &&
          !this.validator.processedIndices.has(e.index)
        );
        
        if (responseEntry) {
          this.validator.processedIndices.add(entry.index);
          this.validator.processedIndices.add(responseEntry.index);
          this.recordSuccess('themis_batch_request_validation', entry);
          this.recordSuccess('themis_batch_response_validation', responseEntry);
          logger.info('Marked Themis-Eligibility pair as processed', {
            requestIndex: entry.index,
            responseIndex: responseEntry.index,
            lenderOrgId: entry.lenderOrgId
          });
        }
        break;
      }
    }
    
    if (!responseEntry) {
      logger.warn('No matching Themis-Eligibility response found, returning synthetic ineligible response', {
        lenderOrgId: incoming.lenderOrgId,
        requestId: incoming.requestId
      });
      return {
        success: true,
        payload: buildSyntheticThemisIneligibleResponse(incoming.lenderOrgId),
        lenderOrgId: incoming.lenderOrgId,
        synthetic: true
      };
    }
    
    // Compare request payload
    const comparison = this.comparePayloads(requestEntry.payload, incoming.payload, incoming.logTag);
    if (!comparison.match) {
      logger.warn('Themis-Eligibility payload mismatch tolerated', {
        lenderOrgId: incoming.lenderOrgId,
        requestId: incoming.requestId,
        differences: comparison.differences
      });
    }
    
    logger.info('Themis-Eligibility batch request validated, returning response', {
      lenderOrgId: incoming.lenderOrgId
    });

    if (requestEntry) {
      const parentContextKey = requestEntry.orderId || requestEntry.loanApplicationId;
      if (parentContextKey && this.asyncTracker.asyncCallTracker.has(parentContextKey)) {
        const isComplete = this.asyncTracker.trackAsyncCompletion(parentContextKey, requestEntry);
        logger.info('Tracked Themis-Eligibility async completion', {
          parentContextKey,
          lenderOrgId: incoming.lenderOrgId,
          actual: this.asyncTracker.asyncCallTracker.get(parentContextKey)?.actual,
          expected: this.asyncTracker.asyncCallTracker.get(parentContextKey)?.expected,
          isComplete
        });
      }
    }
    
    return {
      success: true,
      payload: transformRequest(responseEntry.payload, responseEntry.logTag),
      lenderOrgId: incoming.lenderOrgId
    };
  }

  async handleThemisKFSBatchAsync(incoming) {
    logger.info('Processing Themis-KFS batch asynchronously', {
      lenderOrgId: incoming.lenderOrgId,
      requestId: incoming.requestId
    });
    
    // Find the best matching request/response pair by lenderOrgId.
    // KFS logs can contain duplicate or early-captured entries, so we prefer
    // unprocessed entries first and fall back to any lender-matching pair.
    const kfsRequestEntries = this.validator.entries.filter(entry =>
      entry.logTag === 'Themis-KFS_REQUEST' &&
      entry.source === 'GATEWAY' &&
      (entry.destination === 'LENDER' || entry.destination === 'LSP' || entry.destination === 'THEMIS') &&
      entry.lenderOrgId === incoming.lenderOrgId
    );
    const kfsResponseEntries = this.validator.entries.filter(entry =>
      entry.logTag === 'Themis-KFS_RESPONSE' &&
      (entry.sourceDestination === 'GATEWAY_THEMIS' || entry.sourceDestination === 'GATEWAY_LSP' || entry.sourceDestination === 'GATEWAY_LENDER') &&
      entry.lenderOrgId === incoming.lenderOrgId
    );

    const requestEntry = kfsRequestEntries.find(entry => !this.validator.processedIndices.has(entry.index)) || kfsRequestEntries[0] || null;
    const responseEntry = kfsResponseEntries.find(entry => !this.validator.processedIndices.has(entry.index)) || kfsResponseEntries[0] || null;

    if (!requestEntry || !responseEntry) {
      const synthesizedPayload = this.buildSyntheticThemisKfsPayload(incoming);
      if (synthesizedPayload) {
        logger.warn('Synthesizing Themis-KFS response from recorded FlipKart-GetKFS response', {
          lenderOrgId: incoming.lenderOrgId,
          requestId: incoming.requestId
        });
        return {
          success: true,
          payload: synthesizedPayload,
          lenderOrgId: incoming.lenderOrgId,
          synthesized: true
        };
      }

      logger.error('No matching Themis-KFS response found', {
        lenderOrgId: incoming.lenderOrgId,
        requestId: incoming.requestId,
        requestCandidates: kfsRequestEntries.length,
        responseCandidates: kfsResponseEntries.length
      });
      return {
        success: false,
        error: 'No matching response found'
      };
    }

    if (!this.validator.processedIndices.has(requestEntry.index)) {
      this.validator.processedIndices.add(requestEntry.index);
      this.recordSuccess('themis_kfs_batch_request_validation', requestEntry);
    }
    if (!this.validator.processedIndices.has(responseEntry.index)) {
      this.validator.processedIndices.add(responseEntry.index);
      this.recordSuccess('themis_kfs_batch_response_validation', responseEntry);
    }

    logger.info('Marked Themis-KFS pair as processed', {
      requestIndex: requestEntry.index,
      responseIndex: responseEntry.index,
      lenderOrgId: requestEntry.lenderOrgId
    });

    // Compare request payload. If replay transformed or duplicate KFS entries differ
    // cosmetically, prefer serving the lender-matched response instead of failing hard.
    const comparison = this.comparePayloads(requestEntry.payload, incoming.payload, incoming.logTag);
    if (!comparison.match) {
      logger.warn('Themis-KFS payload mismatch tolerated', {
        lenderOrgId: incoming.lenderOrgId,
        requestId: incoming.requestId,
        differences: comparison.differences
      });
    }
    
    logger.info('Themis-KFS batch request validated, returning response', {
      lenderOrgId: incoming.lenderOrgId
    });
    
    return {
      success: true,
      payload: transformRequest(responseEntry.payload, responseEntry.logTag),
      lenderOrgId: incoming.lenderOrgId
    };
  }

  buildSyntheticThemisKfsPayload(incoming) {
    const matchingAppRequest = this.validator.entries.find(entry =>
      entry.logTag === 'FlipKart-GetKFS_REQUEST' &&
      entry.payload?.lender_code === incoming.lenderOrgId &&
      entry.index <= this.validator.currentIndex
    );

    if (!matchingAppRequest) {
      return null;
    }

    const matchingAppResponse = this.validator.entries.find(entry =>
      entry.logTag === 'FlipKart-GetKFS_RESPONSE' &&
      entry.index > matchingAppRequest.index &&
      entry.payload?.status === 'SUCCESS' &&
      Array.isArray(entry.payload?.documents) &&
      entry.payload.documents.length > 0
    );

    if (!matchingAppResponse) {
      return null;
    }

    return {
      kfsStatements: matchingAppResponse.payload.documents
        .filter(document => Array.isArray(document?.value))
        .map(document => ({ value: document.value }))
    };
  }
  
  findCorrespondingRequest(responseEntry) {
    const expectedSource = responseEntry.destination;
    const expectedDest = responseEntry.source;
    const responseTag = responseEntry.logTag.replace(/_RESPONSE$/, '').replace(/_OUTGOING$/, '');
    
    for (let i = this.validator.currentIndex - 1; i >= 0; i--) {
      const entry = this.validator.entries[i];
      if (!entry.isRequest) continue;
      
      const requestTag = entry.logTag.replace(/_REQUEST$/, '').replace(/_INCOMING$/, '');
      
      if (requestTag === responseTag && 
          entry.source === expectedSource && 
          entry.destination === expectedDest) {
        if (entry.loanApplicationId && responseEntry.loanApplicationId) {
          if (entry.loanApplicationId !== responseEntry.loanApplicationId) continue;
        }
        if (entry.lenderOrgId && responseEntry.lenderOrgId) {
          if (entry.lenderOrgId !== responseEntry.lenderOrgId) continue;
        }
        return entry;
      }
    }
    return null;
  }
  
  sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
  }
  
  getResults() {
    return {
      ...super.getResults(),
      failedBufferRequests: this.httpClient.failedRequests || []
    };
  }

  getStats() {
    return {
      ...this.getResults(),
      bufferStats: this.bufferManager.getStats(),
      activeHttpRequests: this.httpClient.getActiveRequestCount(),
      isPolling: this.isPolling
    };
  }
  
  async stop() {
    this.shouldStop = true;
    
    while (this.isPolling) {
      await this.sleep(10);
    }
    
    this.bufferManager.clear();
    this.httpClient.cleanup(0);
    
    await super.stop();
    
    logger.info('Async orchestrator stopped');
  }
}
