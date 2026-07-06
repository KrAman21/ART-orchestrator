import { StateManager } from './services/state-manager.js';
import { LogSequenceValidator } from './services/log-sequence-validator.js';
import { compareLog } from './services/comparator.js';
import { logger } from './utils/logger.js';
import { getApiForLogTag as getApiFromConfig, getEndpointConfig, SERVICE_MAP, SKIP_DESTINATIONS, isAsyncParallelApi, LENDER_ORG_ID_TO_ID_MAP, normalizeSourceDestination } from './config.js';
import { transformRequest } from './services/request-transformer.js';
import { makeRequest } from './services/http-client.js';

import { SeedDataManager } from './onboarding/seed-data-manager.js';
import { RetryHandler } from './incoming-handlers/retry-handler.js';
import { OutOfOrderHandler } from './incoming-handlers/out-of-order-handler.js';
import { LogProcessor } from './processing/log-processor.js';
import { RequestForwarder } from './processing/request-forwarder.js';
import { AsyncTracker } from './async-tracking/async-tracker.js';
import { isThemisEligibilitySpecialCase, isThemisKfsSpecialCase } from './replay-special-cases.js';
import {
  findAllCorrespondingResponseEntries,
  findCorrespondingResponseEntry,
  matchesRequestContext
} from './services/response-matcher.js';

function extractReplayIndexFromResultEntry(entryText) {
  if (typeof entryText !== 'string') {
    return null;
  }

  const match = entryText.match(/^\[(\d+)\]/);
  return match ? Number(match[1]) : null;
}

function shouldTrustLiveLoanApplicationIdSource(incoming) {
  const source = incoming?.source || null;
  const destination = incoming?.destination || null;

  return source === 'LSP' ||
    source === 'GATEWAY' ||
    destination === 'LSP' ||
    destination === 'GATEWAY';
}

function collectLineScopedIdentifierCandidates(payload) {
  const candidates = new Set();
  const push = value => {
    if (typeof value === 'string' && value.trim()) {
      candidates.add(value.trim());
    }
  };

  if (!payload || typeof payload !== 'object') {
    return candidates;
  }

  push(payload.lineDetailId);
  push(payload.lineId);
  push(payload.referenceId);
  push(payload.applicationid);
  push(payload.ApplicationId);
  push(payload?.lineDetail?.lineDetailId);
  push(payload?.lineDetail?.lineId);
  push(payload?.lineDetail?.referenceId);
  push(payload?.lineDetail?.lineDetailExtensibleData?.referenceId);
  push(payload?.lineDetail?.lineDetailExtensibleData?.lineDetailExtensibleDataId);

  return candidates;
}

function isSuspiciousReplayLoanApplicationIdCandidate(stateManager, loanApplicationId, payload) {
  if (!loanApplicationId || typeof loanApplicationId !== 'string') {
    return false;
  }

  const lineScopedCandidates = collectLineScopedIdentifierCandidates(payload);
  if (lineScopedCandidates.has(loanApplicationId)) {
    return true;
  }

  const lineDetailMappings = stateManager?.identifierMappings?.get?.('lineDetailId');
  if (lineDetailMappings) {
    for (const mappedValue of lineDetailMappings.values()) {
      if (mappedValue === loanApplicationId) {
        return true;
      }
    }
  }

  return false;
}

export class ReplayOrchestrator {
  constructor(logs, config = {}) {
    this.config = {
      timeoutMs: 10000,
      ...config
    };

    this.stateManager = new StateManager({
      defaultTimeoutMs: this.config.timeoutMs
    });

    this.results = {
      passed: 0,
      failed: 0,
      errors: [],
      processedLogs: [],
      payloadComparisons: []
    };

    this.pendingExternalRequests = new Map();
    this.earlyExternalResponses = new Map();
    this.requestToExternalCalls = new Map();
    this.asyncCallTracker = new Map();
    this.observedIncomingRequests = [];
    this.observedProcessedResponses = [];
    this.syntheticRejectedFibeLoanApplications = new Set();

    this.isRunning = false;
    this.failureReason = null;
    this.reportGenerator = config.reportGenerator || null;
    this.orderProfiler = config.orderProfiler || null;
    this.orderId = config.orderId || null;
    this.flowFailures = [];

    this.loadLogs(logs);
  }

  loadLogs(logs) {
    this.logs = logs;
    this.validator = new LogSequenceValidator(logs);
    this.seedDataManager = new SeedDataManager(logs);
    this.stateManager.seedProdLoanApplicationIdsFromLogs(logs);
    this.stateManager.seedProdAgreementIdsFromLogs(logs);
    this.stateManager.seedProdOfferIdsFromLogs(logs);
    this.stateManager.seedProdSessionTokensFromLogs(logs);
    this.stateManager.seedProdTxnRefIdsFromLogs(logs);
    this.stateManager.seedProdCustomerIdsFromLogs(logs);
    this.stateManager.seedProdRequestIdsFromLogs(logs);
    this.resetState();
  }

  resetState() {
    this.results = {
      passed: 0,
      failed: 0,
      errors: [],
      processedLogs: [],
      payloadComparisons: []
    };

    this.pendingExternalRequests.clear();
    this.earlyExternalResponses.clear();
    this.requestToExternalCalls.clear();
    this.asyncCallTracker.clear();
    this.observedIncomingRequests = [];
    this.observedProcessedResponses = [];
    this.syntheticRejectedFibeLoanApplications.clear();

    this.isRunning = false;

    this._initHandlers();
  }

  rewindToReplayIndex(targetIndex) {
    const rewound = this.validator.rewindToIndex(targetIndex);
    if (!rewound) {
      return false;
    }

    this.stateManager.clearReplayTransientState({ preserveReplayRequestIds: true });
    this.pendingExternalRequests.clear();
    this.earlyExternalResponses.clear();
    this.requestToExternalCalls.clear();
    this.asyncCallTracker.clear();
    this.observedIncomingRequests = [];
    this.observedProcessedResponses = [];
    this.flowFailures = [];
    this.failureReason = null;

    this.results.processedLogs = this.results.processedLogs.filter(log => {
      const replayIndex = extractReplayIndexFromResultEntry(log.entry);
      return replayIndex === null || replayIndex < targetIndex;
    });
    this.results.errors = this.results.errors.filter(error => {
      const replayIndex = extractReplayIndexFromResultEntry(error.entry);
      return replayIndex === null || replayIndex < targetIndex;
    });
    this.results.payloadComparisons = this.results.payloadComparisons.filter(comparison =>
      comparison.logIndex === null || comparison.logIndex < targetIndex
    );
    this.results.passed = this.results.processedLogs.length;
    this.results.failed = this.results.errors.length;

    this.isRunning = true;

    logger.info('Rewound orchestrator replay state in place', {
      orderId: this.orderId,
      targetIndex,
      processedLogsRetained: this.results.processedLogs.length,
      payloadComparisonsRetained: this.results.payloadComparisons.length
    });

    return true;
  }

  _initHandlers() {
    this.retryHandler = new RetryHandler({
      validator: this.validator,
      stateManager: this.stateManager,
      pendingExternalRequests: this.pendingExternalRequests,
      logger: logger
    });

    this.outOfOrderHandler = new OutOfOrderHandler({
      stateManager: this.stateManager,
      validator: this.validator,
      logger: logger,
      asyncCallTracker: this.asyncCallTracker,
      callbacks: {
        forwardToDestination: this.forwardToDestination.bind(this),
        trackAsyncCompletion: this.trackAsyncCompletion.bind(this),
        findCorrespondingResponse: this.findCorrespondingResponse.bind(this),
        comparePayloads: this.comparePayloads.bind(this),
        fail: this.fail.bind(this),
        isAsyncParallelCall: this.isAsyncParallelCall.bind(this),
        mockExternalRequest: this.mockExternalRequest.bind(this),
        handleIncomingRequest: this.handleIncomingRequest.bind(this)
      }
    });

    this.asyncTracker = new AsyncTracker({
      asyncCallTracker: this.asyncCallTracker,
      pendingExternalRequests: this.pendingExternalRequests,
      logger: logger,
      validator: this.validator,
      config: this.config,
      callbacks: {
        getContextKey: this.getContextKey.bind(this)
      }
    });

    this.requestForwarder = new RequestForwarder({
      validator: this.validator,
      stateManager: this.stateManager,
      logger: logger,
      config: this.config,
      callbacks: {
        getContextKey: this.getContextKey.bind(this),
        findCorrespondingResponse: this.findCorrespondingResponse.bind(this),
        findAllCorrespondingResponses: this.findAllCorrespondingResponses.bind(this),
        comparePayloads: this.comparePayloads.bind(this),
        recordSuccess: this.recordSuccess.bind(this),
        recordFailure: this.recordFailure.bind(this),
        getServiceBaseUrl: this.getServiceBaseUrl.bind(this),
        getServiceUnixSocket: this.getServiceUnixSocket.bind(this),
        processNextLogEntry: this.processNextLogEntry.bind(this),
        shouldAutoProcessNextLogEntry: () => true,
        shouldBlockOnHeldExternalRequest: () => true,
        trackAsyncCompletion: this.trackAsyncCompletion.bind(this),
        fail: this.fail.bind(this),
        recordBufferFailure:
          typeof this.recordBufferFailure === 'function'
            ? this.recordBufferFailure.bind(this)
            : null,
        buildFailureFallbackResponse:
          typeof this.buildFailureFallbackResponse === 'function'
            ? this.buildFailureFallbackResponse.bind(this)
            : null,
        recordFlowFailure: this.recordFlowFailure.bind(this)
      }
    });

    this.requestForwarder.pendingExternalRequests = this.pendingExternalRequests;
    this.requestForwarder.earlyExternalResponses = this.earlyExternalResponses;

    this.logProcessor = new LogProcessor({
      validator: this.validator,
      stateManager: this.stateManager,
      logger: logger,
      config: this.config,
      callbacks: {
        getApiForLogTag: this.getApiForLogTag.bind(this),
        comparePayloads: this.comparePayloads.bind(this),
        recordSuccess: this.recordSuccess.bind(this),
        recordFailure: this.recordFailure.bind(this),
        fail: this.fail.bind(this),
        getServiceBaseUrl: this.getServiceBaseUrl.bind(this),
        getServiceUnixSocket: this.getServiceUnixSocket.bind(this),
        forwardToDestination: this.forwardToDestination.bind(this),
        processNextLogEntry: this.processNextLogEntry.bind(this)
      }
    });
  }

  static extractMerchantId(logs) {
    return SeedDataManager.extractMerchantId(logs);
  }

  static extractLenderOrgIds(logs) {
    return SeedDataManager.extractLenderOrgIds(logs);
  }

  static extractLineDetails(logs) {
    return SeedDataManager.extractLineDetails(logs);
  }

  static extractCustomerSeedData(logs) {
    return SeedDataManager.extractCustomerSeedData(logs);
  }

  static extractLineSeedData(logs) {
    return SeedDataManager.extractLineSeedData(logs);
  }

  getContextKey(entry) {
    const parts = [];
    if (entry.loanApplicationId) {
      parts.push(entry.loanApplicationId);
    }
    if (entry.lenderOrgId) {
      parts.push(entry.lenderOrgId);
    }
    if (parts.length === 0 && entry.orderId) {
      return entry.orderId;
    }
    return parts.join(':') || entry.requestId || `${entry.index}`;
  }

  async onboardSeedData(merchantId, lenderOrgIdToIdMap, lineDetails, customerSeedData, lineSeedData) {
    return this.seedDataManager.onboardSeedData(merchantId, lenderOrgIdToIdMap, lineDetails, customerSeedData, lineSeedData);
  }

  async clearLspData(merchantId, orderId) {
    return this.seedDataManager.clearLspData(merchantId, orderId);
  }

  async start() {
    if (this.isRunning) {
      logger.warn('Orchestrator already running, ignoring start() call');
      return {
        success: false,
        message: 'Orchestrator already running',
        alreadyRunning: true,
        progress: this.validator.getProgress()
      };
    }

    this.isRunning = true;
    const { merchantId, orderId } = ReplayOrchestrator.extractMerchantId(this.logs);
    const lenderOrgIdToIdMap = ReplayOrchestrator.extractLenderOrgIds(this.logs);
    const lineDetails = ReplayOrchestrator.extractLineDetails(this.logs);
    const customerSeedData = ReplayOrchestrator.extractCustomerSeedData(this.logs);
    const lineSeedData = ReplayOrchestrator.extractLineSeedData(this.logs);

    if (this.orderProfiler?.enabled) {
      await this.orderProfiler.measure('clear_lsp_data', () => this.clearLspData(merchantId, orderId), {
        merchantId,
        orderId
      });
    } else {
      await this.clearLspData(merchantId, orderId);
    }
    // Set Onboarding data for the merchant to ensure LSP is ready for the replay session
    if (this.orderProfiler?.enabled) {
      await this.orderProfiler.measure('onboard_seed_data', () => this.onboardSeedData(merchantId, lenderOrgIdToIdMap, lineDetails, customerSeedData, lineSeedData), {
        merchantId,
        lenderOrgCount: Object.keys(lenderOrgIdToIdMap || {}).length
      });
    } else {
      await this.onboardSeedData(merchantId, lenderOrgIdToIdMap, lineDetails, customerSeedData, lineSeedData);
    }

    logger.info('Replay orchestrator started', {
      totalLogs: this.logs.length,
      validator: this.validator.getProgress()
    });

    await this.processNextLogEntry();

    return {
      success: true,
      message: 'Orchestrator started successfully',
      progress: this.validator.getProgress()
    };
  }

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

    if (entry.shouldSkip()) {
      logger.info('Skipping entry', { entry: entry.toString() });
      this.validator.markProcessed(entry);
      if (this.isRunning) {
        setImmediate(() => {
          this.processNextLogEntry().catch(err => {
            logger.error('Error processing next log entry after skip', { error: err.message });
          });
        });
      }
      return;
    }

    const isInternalLspCall = entry.sourceDestination === 'CORE_EULER' ||
                              entry.sourceDestination === 'CORE_THEMIS' ||
                              (entry.source === 'CORE' && entry.destination === 'EULER') ||
                              (entry.source === 'CORE' && entry.destination === 'THEMIS');

    if (isInternalLspCall && entry.isRequest) {
      logger.info('Internal LSP call - mocking request/response', {
        entry: entry.toString()
      });
      await this.mockInternalLspRequest(entry);
      return;
    }

    const orchestratorInitiatedSources = ['APP', 'LENDER', 'EULER', 'THEMIS'];
    const shouldOrchestratorInitiate = orchestratorInitiatedSources.includes(entry.source) ||
      (entry.source === 'CORE' && entry.destination === 'GATEWAY' && entry.logTag === 'LSP-FetchOfferSync_REQUEST');

    if (shouldOrchestratorInitiate && entry.isRequest) {
      logger.info('External source request - triggering from orchestrator', {
        entry: entry.toString(),
        source: entry.source
      });
      await this.triggerExternalRequest(entry);
    } else if (entry.isRequest) {
      logger.info('Waiting for incoming request from service', {
        entry: entry.toString(),
        source: entry.source,
        destination: entry.destination
      });
    } else {
      logger.debug('Not a request entry, skipping trigger', {
        entry: entry.toString()
      });
    }
  }

  async triggerExternalRequest(entry) {
    return this.logProcessor.triggerExternalRequest(entry);
  }

  mockInternalLspRequest(expectedEntry) {
    return this.logProcessor.mockInternalLspRequest(expectedEntry);
  }

  getApiForLogTag(logTag) {
    return getApiFromConfig(logTag) || '/api/unknown';
  }

  async stop() {
    this.isRunning = false;
    this.stateManager.cleanup();
    logger.info('Replay orchestrator stopped');
  }

  async handleIncomingRequest(incoming) {
    if (!this.isRunning) {
      throw new Error('Orchestrator not running');
    }

    this.recordObservedIncomingRequest(incoming);
    this.stateManager.recordForwardedFor(incoming);

    logger.info('ORCH_RECEIVING', {
      source: incoming.source,
      destination: incoming.destination,
      api: incoming.api,
      requestId: incoming.requestId,
      payload: incoming.payload,
      headers: incoming.headers,
      timestamp: new Date().toISOString()
    });

    if (isThemisEligibilitySpecialCase(incoming.logTag) && incoming.source === 'GATEWAY' && (incoming.destination === 'LENDER' || incoming.destination === 'LSP' || incoming.destination === 'THEMIS')) {
      return await this.handleThemisEligibilityBatch(incoming);
    }

    if (isThemisKfsSpecialCase(incoming.logTag)) {
      logger.info('Received request for THEMIS-KFS, checking if it should be mocked', {
        source: incoming.source,
        destination: incoming.destination,
        api: incoming.api,
        logTag: incoming.logTag
      });
      return await this.handleThemisKFSReq(incoming);
    }

    const expectedEntry = this.validator.getCurrentEntry();

    logger.info('ORCH_CURRENT_EXPECTATION', {
      orderId: this.orderId,
      incoming: {
        source: incoming.source,
        destination: incoming.destination,
        logTag: incoming.logTag,
        requestId: incoming.requestId,
        lenderOrgId: incoming.lenderOrgId || null,
        loanApplicationId: incoming.loanApplicationId || incoming.payload?.loanApplicationId || incoming.payload?.loan_application_id || null,
        orderId: incoming.orderId || incoming.headers?.['x-order-id'] || incoming.payload?.orderId || incoming.payload?.order_id || null
      },
      expectedEntry: expectedEntry?.toString?.() || null,
      currentIndex: this.validator?.currentIndex ?? null,
      processedCount: this.validator?.processedIndices?.size || 0
    });

    if (!expectedEntry) {
      // If the polling loop has already completed, this is a late straggler arriving
      // after all logs were processed — ignore it gracefully instead of failing.
      if (this.validator.isComplete()) {
        logger.warn('Ignoring late straggler request after replay completion', {
          source: incoming.source,
          destination: incoming.destination,
          logTag: incoming.logTag
        });
        return { success: true, ignored: true };
      }
      return await this.fail('No more entries to process - unexpected request');
    }

    const syntheticCompatibilityResponse = this.maybeHandleSyntheticFibeGenerateToken(incoming);
    if (syntheticCompatibilityResponse) {
      return syntheticCompatibilityResponse;
    }

    const syntheticCheckoutStatusResponse = this.maybeHandleSyntheticFibeCheckoutStatus(incoming);
    if (syntheticCheckoutStatusResponse) {
      return syntheticCheckoutStatusResponse;
    }

    const loanApplicationDataResponse = await this.maybePassThroughFetchLoanApplicationData(incoming);
    if (loanApplicationDataResponse) {
      return loanApplicationDataResponse;
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

    let validation = this.validator.validateIncomingRequest({
      source: normalizedIncoming.source,
      destination: normalizedIncoming.destination,
      logTag: normalizedIncoming.logTag,
      isRequest: true,
      requestId: normalizedIncoming.requestId,
      lenderOrgId: normalizedIncoming.lenderOrgId
    });

    logger.info('ORCH_INCOMING_VALIDATION_RESULT', {
      orderId: this.orderId,
      incoming: {
        source: normalizedIncoming.source,
        destination: normalizedIncoming.destination,
        logTag: normalizedIncoming.logTag,
        requestId: normalizedIncoming.requestId,
        lenderOrgId: normalizedIncoming.lenderOrgId || null,
        loanApplicationId: normalizedIncoming.loanApplicationId || normalizedIncoming.payload?.loanApplicationId || normalizedIncoming.payload?.loan_application_id || null,
        orderId: normalizedIncoming.orderId || normalizedIncoming.headers?.['x-order-id'] || normalizedIncoming.payload?.orderId || normalizedIncoming.payload?.order_id || null
      },
      expectedEntry: expectedEntry?.toString?.() || null,
      validation: {
        valid: validation.valid,
        error: validation.error || null,
        alreadyProcessed: validation.alreadyProcessed || false,
        isEarly: validation.isEarly || false,
        isAsyncParallelCall: validation.isAsyncParallelCall || false,
        expectedEntry: validation.expectedEntry?.toString?.() || null,
        foundInLookahead: validation.foundInLookahead?.toString?.() || null
      }
    });

    if (incoming.source === 'LENDER' && incoming.destination === 'GW') {
      return await this.handleExternalServiceResponse(incoming);
    }

    const retryResult = this.retryHandler.handleRetryRequest(incoming);
    if (retryResult) {
      logger.info('Handled retried request', {
        source: incoming.source,
        destination: incoming.destination,
        api: incoming.api
      });
      return retryResult;
    }

    if (!validation.valid && (validation.foundInLookahead || validation.isAsyncParallelCall)) {
      return await this.outOfOrderHandler.handleOutOfOrderRequest(incoming, validation);
    }

    if (validation.isEarly) {
      logger.debug('Got request when expecting response, checking for retries', {
        expected: expectedEntry?.toString(),
        received: `${incoming.source}→${incoming.destination} ${incoming.logTag}`
      });

      const futureEntry = this.validator.entries.find(entry =>
        entry.index > this.validator.currentIndex &&
        !this.validator.processedIndices.has(entry.index) &&
        entry.isRequest &&
        this.validator.matchesExpected(entry, normalizedIncoming)
      );

      if (futureEntry) {
        logger.info('Early request has future unprocessed replay match, not returning cached response', {
          expected: expectedEntry?.toString(),
          futureEntry: futureEntry.toString(),
          incomingLogTag: incoming.logTag,
          incomingRequestId: incoming.requestId
        });
        return await this.outOfOrderHandler.handleOutOfOrderRequest(incoming, {
          ...validation,
          foundInLookahead: futureEntry
        });
      }

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
            payload: transformRequest(responseEntry.payload, responseEntry.logTag),
            cached: true
          };
        }
      }
    }

    if (!validation.valid) {
      return await this.fail(validation.error);
    }

    const buffered = this.stateManager.findBufferedRequest({
      source: expectedEntry.source,
      destination: expectedEntry.destination,
      logTag: expectedEntry.logTag,
      opportunityId: extractOpportunityId(expectedEntry)
    });

    if (buffered) {
      this.stateManager.removeBufferedRequest(buffered.key);
      logger.info('Using buffered request instead of new one', {
        bufferedKey: buffered.key,
        newRequestId: incoming.requestId,
        bufferedRequestId: buffered.data.requestId
      });
      incoming = buffered.data;
    }

    incoming = this.maybeNormalizeRejectedFibeFetchOfferCallback(incoming, expectedEntry);
    incoming = this.normalizeIncomingReplayIdentifiers(incoming);

    this.registerReplayIdentifierMappings(expectedEntry, incoming);

    logger.logApiCall(incoming.source, incoming.destination, incoming.api, 'REQUEST', expectedEntry.index);

    const expectedPayload = expectedEntry.payload;

    logger.info('ORCH_COMPARING_PAYLOADS', {
      logTag: incoming.logTag,
      sourceDestination: expectedEntry.sourceDestination,
      expectedKeys: Object.keys(expectedPayload || {}),
      actualKeys: Object.keys(incoming.payload || {}),
      expectedSample: JSON.stringify(expectedPayload)?.substring(0, 500),
      actualSample: JSON.stringify(incoming.payload)?.substring(0, 500)
    });

    const comparison = this.comparePayloads(expectedPayload, incoming.payload, incoming.logTag);

    if (!comparison.match) {
      logger.warn('ORCH_PAYLOAD_MISMATCH', {
        logTag: incoming.logTag,
        differences: comparison.differences,
        expectedFull: expectedPayload,
        actualFull: incoming.payload
      });
    }

    if (expectedEntry.source === 'CORE' && expectedEntry.destination === 'GATEWAY') {
      const contextKey = this.getContextKey(expectedEntry);
      const existingTracker = this.asyncCallTracker.get(contextKey);
      if (!existingTracker) {
        this.asyncTracker.initializeAsyncTracking(expectedEntry);
      }
    }

    logger.info('Request validation passed', {
      entry: expectedEntry.toString(),
      comparisonMatch: true
    });

    this.validator.advance();
    this.recordSuccess('request_validation', expectedEntry);

    const response = await this.forwardToDestination(incoming, expectedEntry);

    const contextKey = this.getContextKey(expectedEntry);
    const tracker = this.asyncCallTracker.get(contextKey);

    if (tracker && tracker.expected > 0) {
      logger.info('Parent request forwarded, waiting for async calls to complete', {
        contextKey,
        expectedAsyncCalls: tracker.expected
      });
      await this.waitForAllExternalCalls();
      this.asyncTracker.cleanupAsyncTracking(contextKey);
    } else if (response?.externalSkipped) {
      await this.waitForAllExternalCalls();
    }

    return response;
  }

  recordObservedIncomingRequest(incoming) {
    if (!incoming?.logTag) {
      return;
    }

    const sourceDestination = normalizeSourceDestination(
      incoming.sourceDestination || `${incoming.source}_${incoming.destination}`,
      incoming.logTag
    );

    const observedLoanApplicationIds = this.stateManager.extractProdLoanApplicationIdsFromValue(incoming);
    const observedAgreementIds = this.stateManager.extractProdAgreementIdsFromValue(incoming);
    const observedOfferIds = this.stateManager.extractProdOfferIdsFromValue(incoming, { logTag: incoming.logTag });
    const observedSessionTokens = this.stateManager.extractProdSessionTokensFromValue(incoming);
    const observedTxnRefIds = this.stateManager.extractProdTxnRefIdsFromValue(incoming);
    const observedCustomerIds = this.stateManager.extractProdCustomerIdsFromValue(incoming);
    const observedRequestIds = this.stateManager.extractProdRequestIdsFromValue(incoming);
    const observedLoanApplicationId =
      incoming.loanApplicationId ||
      observedLoanApplicationIds[observedLoanApplicationIds.length - 1] ||
      null;
    const observedSessionToken =
      incoming.headers?.['x-session-token'] ||
      incoming.headers?.['X-Session-Token'] ||
      observedSessionTokens[observedSessionTokens.length - 1] ||
      null;
    const observedAgreementId =
      incoming.agreementId ||
      observedAgreementIds[observedAgreementIds.length - 1] ||
      null;
    const observedOfferId =
      incoming.offerId ||
      observedOfferIds[observedOfferIds.length - 1] ||
      null;
    const observedTxnRefId =
      incoming.txnRefId ||
      observedTxnRefIds[observedTxnRefIds.length - 1] ||
      null;
    const observedCustomerId =
      incoming.customerId ||
      observedCustomerIds[observedCustomerIds.length - 1] ||
      null;
    const observedRequestId =
      incoming.requestId ||
      incoming.headers?.['x-request-id'] ||
      incoming.headers?.['X-Request-Id'] ||
      observedRequestIds[observedRequestIds.length - 1] ||
      null;

    this.observedIncomingRequests.push({
      source: incoming.source,
      destination: incoming.destination,
      sourceDestination,
      logTag: incoming.logTag,
      lenderOrgId: incoming.lenderOrgId || null,
      loanApplicationId: observedLoanApplicationId,
      offerId: observedOfferId,
      txnRefId: observedTxnRefId,
      customerId: observedCustomerId,
      orderId: incoming.orderId || incoming.headers?.['x-order-id'] || null,
      requestId: incoming.requestId || null,
      payload: incoming.payload || null,
      timestamp: incoming.timestamp || incoming._timestamp || null,
      observedAt: Date.now()
    });

    if (this.observedIncomingRequests.length > 500) {
      this.observedIncomingRequests.splice(0, this.observedIncomingRequests.length - 500);
    }

    if (observedRequestId && shouldTrustLiveLoanApplicationIdSource(incoming)) {
      this.stateManager.setReplayRequestIdForLogTag(incoming.logTag, observedRequestId, {
        source: incoming.source,
        destination: incoming.destination,
        sourceDestination,
        requestId: incoming.requestId || null
      });
    } else if (observedRequestId) {
      logger.info('Ignoring observed requestId for replay remap because source is not trusted', {
        observedRequestId,
        logTag: incoming.logTag,
        source: incoming.source || null,
        destination: incoming.destination || null,
        sourceDestination
      });
    }

    if (
      observedLoanApplicationId &&
      shouldTrustLiveLoanApplicationIdSource(incoming) &&
      !isSuspiciousReplayLoanApplicationIdCandidate(this.stateManager, observedLoanApplicationId, incoming.payload)
    ) {
      this.stateManager.setCurrentReplayLoanApplicationId(observedLoanApplicationId, {
        logTag: incoming.logTag,
        source: incoming.source,
        destination: incoming.destination,
        sourceDestination,
        requestId: incoming.requestId || null
      });
    } else if (
      observedLoanApplicationId &&
      shouldTrustLiveLoanApplicationIdSource(incoming) &&
      isSuspiciousReplayLoanApplicationIdCandidate(this.stateManager, observedLoanApplicationId, incoming.payload)
    ) {
      logger.info('Ignoring observed loanApplicationId for replay remap because it matches line-scoped identifiers', {
        observedLoanApplicationId,
        logTag: incoming.logTag,
        source: incoming.source || null,
        destination: incoming.destination || null,
        sourceDestination
      });
    } else if (observedLoanApplicationId) {
      logger.info('Ignoring observed loanApplicationId for replay remap because source is not trusted', {
        observedLoanApplicationId,
        logTag: incoming.logTag,
        source: incoming.source || null,
        destination: incoming.destination || null,
        sourceDestination
      });
    }

    if (observedAgreementId && shouldTrustLiveLoanApplicationIdSource(incoming)) {
      this.stateManager.setCurrentReplayAgreementId(observedAgreementId, {
        logTag: incoming.logTag,
        source: incoming.source,
        destination: incoming.destination,
        sourceDestination,
        requestId: incoming.requestId || null
      });
    } else if (observedAgreementId) {
      logger.info('Ignoring observed agreementId for replay remap because source is not trusted', {
        observedAgreementId,
        logTag: incoming.logTag,
        source: incoming.source || null,
        destination: incoming.destination || null,
        sourceDestination
      });
    }

    if (observedOfferId && incoming.logTag === 'LSP-SelectOffer_REQUEST' && shouldTrustLiveLoanApplicationIdSource(incoming)) {
      this.stateManager.setCurrentReplayOfferId(observedOfferId, {
        logTag: incoming.logTag,
        source: incoming.source,
        destination: incoming.destination,
        sourceDestination,
        requestId: incoming.requestId || null
      });
    } else if (observedOfferId) {
      logger.info('Ignoring observed offerId for replay remap because source/logTag is not trusted', {
        observedOfferId,
        logTag: incoming.logTag,
        source: incoming.source || null,
        destination: incoming.destination || null,
        sourceDestination
      });
    }

    if (observedSessionToken && shouldTrustLiveLoanApplicationIdSource(incoming)) {
      this.stateManager.setCurrentReplaySessionToken(observedSessionToken, {
        logTag: incoming.logTag,
        source: incoming.source,
        destination: incoming.destination,
        sourceDestination,
        requestId: incoming.requestId || null
      });
    } else if (observedSessionToken) {
      logger.info('Ignoring observed session token for replay remap because source is not trusted', {
        observedSessionToken,
        logTag: incoming.logTag,
        source: incoming.source || null,
        destination: incoming.destination || null,
        sourceDestination
      });
    }

    if (observedTxnRefId && sourceDestination === 'GATEWAY_LENDER') {
      this.stateManager.setCurrentReplayTxnRefId(observedTxnRefId, {
        logTag: incoming.logTag,
        source: incoming.source,
        destination: incoming.destination,
        sourceDestination,
        requestId: incoming.requestId || null
      });
    } else if (observedTxnRefId) {
      logger.info('Ignoring observed txnRefId for replay remap because source is not GATEWAY_LENDER', {
        observedTxnRefId,
        logTag: incoming.logTag,
        source: incoming.source || null,
        destination: incoming.destination || null,
        sourceDestination
      });
    }

    if (observedCustomerId && shouldTrustLiveLoanApplicationIdSource(incoming)) {
      this.stateManager.setCurrentReplayCustomerId(observedCustomerId, {
        logTag: incoming.logTag,
        source: incoming.source,
        destination: incoming.destination,
        sourceDestination,
        requestId: incoming.requestId || null
      });
    } else if (observedCustomerId) {
      logger.info('Ignoring observed customerId for replay remap because source is not trusted', {
        observedCustomerId,
        logTag: incoming.logTag,
        source: incoming.source || null,
        destination: incoming.destination || null,
        sourceDestination
      });
    }
  }

  recordObservedProcessedResponse(expectedEntry, actualPayload) {
    if (!expectedEntry?.logTag) {
      return;
    }

    this.observedProcessedResponses.push({
      source: expectedEntry.source,
      destination: expectedEntry.destination,
      logTag: expectedEntry.logTag,
      lenderOrgId: expectedEntry.lenderOrgId || actualPayload?.lenderOrgId || actualPayload?.lender_org_id || null,
      loanApplicationId:
        expectedEntry.loanApplicationId ||
        actualPayload?.loanApplicationId ||
        actualPayload?.loan_application_id ||
        null,
      orderId: expectedEntry.orderId || actualPayload?.orderId || actualPayload?.order_id || null,
      payload: actualPayload || null,
      observedAt: Date.now()
    });

    if (this.observedProcessedResponses.length > 500) {
      this.observedProcessedResponses.splice(0, this.observedProcessedResponses.length - 500);
    }
  }

  async handleDownstreamResponse(incomingResponse) {
    return this.requestForwarder.handleDownstreamResponse(incomingResponse);
  }

  async forwardToDestination(incoming, expectedEntry) {
    return this.requestForwarder.forwardToDestination(incoming, expectedEntry);
  }

  async handleExternalServiceResponse(incoming) {
    return this.requestForwarder.handleExternalServiceResponse(incoming);
  }

  handleRetryRequest(incoming) {
    return this.retryHandler.handleRetryRequest(incoming);
  }

  maybeHandleSyntheticFibeGenerateToken(incoming) {
    const isFibeGenerateTokenRequest =
      ['GENERATE_TOKEN_API_REQUEST', 'FIBE_GENERATE_TOKEN_API_REQUEST'].includes(incoming?.logTag) &&
      (
        incoming.lenderOrgId === 'FIBE' ||
        incoming.api === '/merchant-auth-qa/esapi/generateToken'
      );

    if (
      incoming?.source !== 'GATEWAY' ||
      incoming?.destination !== 'LENDER' ||
      !isFibeGenerateTokenRequest
    ) {
      return null;
    }

    const replayAlreadyContainsTokenStep = this.validator.entries.some(entry =>
      ['GENERATE_TOKEN_API_REQUEST', 'FIBE_GENERATE_TOKEN_API_REQUEST'].includes(entry.logTag) &&
      entry.source === 'GATEWAY' &&
      entry.destination === 'LENDER'
    );

    if (replayAlreadyContainsTokenStep) {
      return null;
    }

    logger.info('Returning synthetic FIBE token for legacy replay logs', {
      requestId: incoming.requestId,
      loanApplicationId: incoming.loanApplicationId,
      currentEntry: this.validator.getCurrentEntry()?.toString()
    });

    this.results.passed++;
    this.results.processedLogs.push({
      step: 'synthetic_generate_token_response',
      entry: `[synthetic] ${incoming.logTag} ${incoming.source}→${incoming.destination}`,
      timestamp: new Date().toISOString()
    });

    return {
      success: true,
      synthetic: true,
      payload: {
        token: 'ART_SYNTHETIC_FIBE_TOKEN',
        statusMessage: 'Success',
        statusCode: 200
      }
    };
  }

  maybeHandleSyntheticFibeCheckoutStatus(incoming) {
    const isFibeCheckoutStatusRequest =
      incoming?.logTag === 'GET_CHECKOUT_STATUS_FO_REQUEST' &&
      incoming?.source === 'GATEWAY' &&
      incoming?.destination === 'LENDER' &&
      (
        incoming.lenderOrgId === 'FIBE' ||
        incoming.api === '/checkoutuat/merchantapiv2/get-checkout-status'
      );

    if (!isFibeCheckoutStatusRequest) {
      return null;
    }

    const replayAlreadyContainsCheckoutStatus = this.validator.entries.some(entry =>
      (entry.logTag === 'GET_CHECKOUT_STATUS_FO_REQUEST' || entry.logTag === 'GET_CHECKOUT_STATUS_LS_REQUEST') &&
      entry.source === 'GATEWAY' &&
      entry.destination === 'LENDER'
    );

    if (replayAlreadyContainsCheckoutStatus) {
      return null;
    }

    const orderId = incoming.payload?.orderId || incoming.loanApplicationId || 'ART_SYNTHETIC_ORDER';
    const customerRefId = incoming.payload?.customerRefId || 'ART_SYNTHETIC_CUSTOMER';
    const replayLoanApplicationIds = new Set([
      incoming.loanApplicationId,
      incoming.payload?.orderId
    ].filter(Boolean));

    for (const [originalLoanApplicationId, localLoanApplicationId] of this.stateManager.loanApplicationIdMappings.entries()) {
      if (replayLoanApplicationIds.has(localLoanApplicationId)) {
        replayLoanApplicationIds.add(originalLoanApplicationId);
      }
    }

    const matchesReplayLoanApplication = entry =>
      replayLoanApplicationIds.has(entry.loanApplicationId) ||
      replayLoanApplicationIds.has(entry.payload?.loanApplicationId) ||
      replayLoanApplicationIds.has(entry.payload?.orderId);

    const profileIngestionResponse = this.validator.entries.find(entry =>
      entry.logTag === 'PROFILE_INGESTION_RESPONSE' &&
      matchesReplayLoanApplication(entry) &&
      entry.payload &&
      typeof entry.payload === 'object'
    )?.payload;
    const rejectedFetchOfferCallback = this.validator.entries.find(entry =>
      entry.logTag === 'FETCH_OFFER_ASYNC_RESPONSE_REQUEST' &&
      matchesReplayLoanApplication(entry) &&
      entry.payload?.loanApplicationStatus === 'REJECTED'
    )?.payload;

    const replayShowsRejectedBranch =
      profileIngestionResponse?.leadStatus === 'ORDER_REJECTED' ||
      rejectedFetchOfferCallback?.response?.error === 'LENDER_REJECTED_BASED_ON_PROFILE' ||
      rejectedFetchOfferCallback?.eligibility?.errorCode === 'LENDER_REJECTED_BASED_ON_PROFILE';

    if (replayShowsRejectedBranch) {
      for (const loanApplicationId of replayLoanApplicationIds) {
        this.syntheticRejectedFibeLoanApplications.add(loanApplicationId);
      }
    }

    const syntheticPayload = replayShowsRejectedBranch
      ? {
          orderId,
          status_code: 200,
          status: 'SUCCESS',
          statusCode: 200,
          orderStatus: 'CANCELLED',
          esStatus: 'ORDER_REJECTED',
          customerRefId,
          breStatus: profileIngestionResponse?.breStatus || null,
          merchantId: null,
          customerStatus: 'REJECTED',
          customerSubStatus: profileIngestionResponse?.leadStatus || 'ORDER_REJECTED',
          isKFSSigned: false,
          kfsValidity: null,
          transactionId: null,
          sanctionData: null,
          data: {
            customerRefId,
            message: profileIngestionResponse?.leadStatus || 'ORDER_REJECTED',
            nachStatus: null
          },
          disbursalDate: null,
          settlementStatus: null,
          utrNo: null,
          orderAmount: null,
          loanAcNo: null,
          productTenure: null,
          final_amount_to_merchant: null,
          downpayment_amount: null,
          emi_amount: null,
          disbursedAmount: null
        }
      : {
          orderId,
          status_code: 200,
          status: 'SUCCESS',
          statusCode: 200,
          orderStatus: 'PENDING',
          esStatus: 'APPROVED',
          customerRefId,
          breStatus: null,
          merchantId: null,
          customerStatus: 'APPROVED',
          customerSubStatus: null,
          isKFSSigned: false,
          kfsValidity: null,
          transactionId: null,
          sanctionData: null,
          data: {
            customerRefId,
            message: 'APPROVED',
            nachStatus: null
          },
          disbursalDate: null,
          settlementStatus: null,
          utrNo: null,
          orderAmount: null,
          loanAcNo: null,
          productTenure: null,
          final_amount_to_merchant: null,
          downpayment_amount: null,
          emi_amount: null,
          disbursedAmount: null
        };

    logger.info('Returning synthetic FIBE checkout status for replay logs without checkout-status step', {
      requestId: incoming.requestId,
      loanApplicationId: incoming.loanApplicationId,
      replayLoanApplicationIds: Array.from(replayLoanApplicationIds),
      orderId,
      customerRefId,
      replayShowsRejectedBranch,
      leadStatus: profileIngestionResponse?.leadStatus || null,
      syntheticOrderStatus: syntheticPayload.orderStatus,
      syntheticEsStatus: syntheticPayload.esStatus,
      currentEntry: this.validator.getCurrentEntry()?.toString()
    });

    this.results.passed++;
    this.results.processedLogs.push({
      step: 'synthetic_get_checkout_status_response',
      entry: `[synthetic] ${incoming.logTag} ${incoming.source}→${incoming.destination}`,
      timestamp: new Date().toISOString()
    });

    return {
      success: true,
      synthetic: true,
      payload: syntheticPayload
    };
  }

  maybeNormalizeRejectedFibeFetchOfferCallback(incoming, expectedEntry) {
    const isRejectedFibeFetchOfferCallback =
      incoming?.logTag === 'FETCH_OFFER_ASYNC_RESPONSE_REQUEST' &&
      incoming?.source === 'GATEWAY' &&
      incoming?.destination === 'LSP' &&
      expectedEntry?.logTag === 'FETCH_OFFER_ASYNC_RESPONSE_REQUEST' &&
      expectedEntry?.payload?.response?.error === 'LENDER_REJECTED_BASED_ON_PROFILE' &&
      incoming?.payload?.response?.error === 'LENDER_SYSTEM_ERROR_RETRY';

    if (!isRejectedFibeFetchOfferCallback) {
      return incoming;
    }

    const candidateIds = [
      incoming.loanApplicationId,
      incoming.payload?.loanApplicationId,
      incoming.payload?.orderId
    ].filter(Boolean);

    let matchesSyntheticRejectedBranch = candidateIds.some(loanApplicationId =>
      this.syntheticRejectedFibeLoanApplications.has(loanApplicationId)
    );

    if (!matchesSyntheticRejectedBranch) {
      for (const [originalLoanApplicationId, localLoanApplicationId] of this.stateManager.loanApplicationIdMappings.entries()) {
        if (
          candidateIds.includes(localLoanApplicationId) &&
          this.syntheticRejectedFibeLoanApplications.has(originalLoanApplicationId)
        ) {
          matchesSyntheticRejectedBranch = true;
          break;
        }
      }
    }

    if (!matchesSyntheticRejectedBranch) {
      return incoming;
    }

    const expectedPayload = expectedEntry.payload || {};
    const actualPayload = incoming.payload || {};
    const normalizedPayload = {
      ...actualPayload,
      loanApplicationStatus: expectedPayload.loanApplicationStatus || actualPayload.loanApplicationStatus,
      response: expectedPayload.response || actualPayload.response,
      eligibility: {
        ...(actualPayload.eligibility || {}),
        ...(expectedPayload.eligibility || {})
      }
    };

    if (expectedPayload.loanLenderData && !actualPayload.loanLenderData) {
      normalizedPayload.loanLenderData = expectedPayload.loanLenderData;
    }

    logger.info('Normalizing post-checkout synthetic FIBE fetch-offer callback to rejected replay payload', {
      requestId: incoming.requestId,
      loanApplicationId: actualPayload.loanApplicationId || incoming.loanApplicationId || null,
      currentEntry: expectedEntry?.toString()
    });

    return {
      ...incoming,
      payload: normalizedPayload
    };
  }

  async maybePassThroughFetchLoanApplicationData(incoming) {
    const isFetchLoanApplicationDataRequest =
      incoming?.api === '/api/fetch/loanApplicationData' ||
      incoming?.logTag === 'FECTH_LOAN_APPLICATION_DATA_API_REQUEST' ||
      incoming?.logTag === 'FETCH_LOAN_APPLICATION_DATA_API_REQUEST';

    if (
      incoming?.source !== 'GATEWAY' ||
      incoming?.destination !== 'LSP' ||
      !isFetchLoanApplicationDataRequest
    ) {
      return null;
    }

    const processedEntry = this.validator?.entries?.find?.(entry =>
      this.validator.processedIndices.has(entry.index) &&
      entry.isRequest &&
      entry.source === incoming.source &&
      entry.destination === incoming.destination &&
      entry.logTag === incoming.logTag &&
      (
        JSON.stringify(entry.payload?.requiredData || entry.payload?.required_data || []) ===
        JSON.stringify(incoming.payload?.requiredData || incoming.payload?.required_data || [])
      )
    );
    this.orderProfiler?.recordDownstreamCall({
      destination: 'LSP',
      endpoint: '/api/fetch/loanApplicationData',
      logTag: incoming.logTag,
      logIndex: null,
      requestId: incoming.requestId,
      status: serviceResponse?.status ?? null,
      success: Boolean(serviceResponse && !serviceResponse.error && serviceResponse.status >= 200 && serviceResponse.status < 300),
      durationMs: this.orderProfiler.now() - lspPassThroughStart
    });

    if (processedEntry) {
      const responseEntry = this.findCorrespondingResponse(processedEntry, true);
      if (responseEntry) {
        logger.info('Returning cached fetchLoanApplicationData response for already-processed replay entry', {
          requestId: incoming.requestId,
          processedEntry: processedEntry.toString(),
          responseEntry: responseEntry.toString(),
          requiredData: incoming.payload?.requiredData || incoming.payload?.required_data || null
        });

        return {
          success: true,
          payload: transformRequest(responseEntry.payload, responseEntry.logTag),
          cached: true
        };
      }
    }

    logger.info('Allowing fetchLoanApplicationData request to be served through normal replay handling', {
      requestId: incoming.requestId,
      incomingLogTag: incoming.logTag,
      requiredData: incoming.payload?.requiredData || incoming.payload?.required_data || null,
      currentEntry: this.validator?.getCurrentEntry?.()?.toString?.() || null
    });

    return null;
  }

  async handleOutOfOrderRequest(incoming, validation) {
    return this.outOfOrderHandler.handleOutOfOrderRequest(incoming, validation);
  }

  isAsyncParallelCall(entry) {
    return isAsyncParallelApi(entry?.sourceDestination, entry?.logTag);
  }

  async processAsyncParallelCall(incoming, matchingEntry) {
    return this.outOfOrderHandler.processAsyncParallelCall(incoming, matchingEntry);
  }

  async mockExternalRequest(expectedEntry) {
    return this.logProcessor.mockExternalRequest(expectedEntry);
  }

  findCorrespondingResponse(requestEntry, searchAll = false) {
    return findCorrespondingResponseEntry(this.validator.entries, requestEntry, {
      searchAll,
      processedIndices: this.validator.processedIndices
    });
  }

  findAllCorrespondingResponses(requestEntry) {
    return findAllCorrespondingResponseEntries(this.validator.entries, requestEntry, {
      searchAll: true,
      processedIndices: this.validator.processedIndices
    });
  }

  matchesRequestContext(requestEntry, responseEntry) {
    return matchesRequestContext(requestEntry, responseEntry);
  }

  initializeAsyncTracking(parentRequestEntry) {
    return this.asyncTracker.initializeAsyncTracking(parentRequestEntry);
  }

  trackAsyncCompletion(contextKey, entry) {
    return this.asyncTracker.trackAsyncCompletion(contextKey, entry);
  }

  async waitForAllExternalCalls() {
    return this.asyncTracker.waitForAllExternalCalls();
  }

  async waitForPendingExternalRequests(currentEntry) {
    return this.asyncTracker.waitForPendingExternalRequests(currentEntry);
  }

  comparePayloads(expected, actual, logTag) {
    const comparison = compareLog(expected, actual, logTag);
    const currentEntry = this.validator.getCurrentEntry();

    this.results.payloadComparisons.push({
      timestamp: new Date().toISOString(),
      logTag,
      logIndex: currentEntry?.index ?? null,
      entry: currentEntry ? currentEntry.toString() : null,
      differenceCount: comparison.differenceList?.length || 0,
      differences: comparison.differenceList || []
    });

    return comparison;
  }

  normalizeIncomingReplayIdentifiers(incoming) {
    if (!incoming) {
      return incoming;
    }

    const remapContext = {
      logTag: incoming.logTag || null
    };

    return {
      ...incoming,
      loanApplicationId: this.stateManager.getMappedIdentifier(
        'loanApplicationId',
        incoming.loanApplicationId
      ),
      txnRefId: this.stateManager.getMappedIdentifier(
        'txnRefId',
        incoming.txnRefId
      ),
      payload: this.stateManager.remapReplayValue(incoming.payload, null, remapContext),
      message: this.stateManager.remapReplayValue(incoming.message, null, remapContext)
    };
  }

  registerReplayIdentifierMappings(expectedEntry, incoming) {
    const identifierContext = {
      logTag: expectedEntry?.logTag || incoming?.logTag || null,
      originalSource: expectedEntry || null,
      localSource: incoming || null,
      expectedPayload:
        expectedEntry?.payload ||
        expectedEntry?.message ||
        null,
      actualPayload:
        incoming?.payload ||
        incoming?.message ||
        null
    };

    for (const identifierType of this.stateManager.getTrackedIdentifierTypes()) {
      const expectedIds = this.collectReplayIdentifiers(expectedEntry, identifierType, identifierContext);
      const actualIds = this.collectReplayIdentifiers(incoming, identifierType, identifierContext);

      for (let index = 0; index < Math.min(expectedIds.length, actualIds.length); index += 1) {
        const originalValue = expectedIds[index];
        const localValue = actualIds[index];
        const didRegister = this.stateManager.registerIdentifierMapping(
          identifierType,
          originalValue,
          localValue,
          identifierContext
        );

        if (
          didRegister &&
          identifierType === 'loanApplicationId' &&
          typeof this.config.onLoanApplicationId === 'function' &&
          this.config.registrySessionId
        ) {
          this.config.onLoanApplicationId(
            localValue,
            this.orderId,
            this.config.registrySessionId
          );
        }
      }
    }
  }

  collectReplayIdentifiers(source, identifierType, context = {}) {
    const ids = [];
    const seen = new Set();

    const visit = value => {
      if (!value || typeof value !== 'object') {
        return;
      }

      if (Array.isArray(value)) {
        value.forEach(visit);
        return;
      }

      for (const [key, nestedValue] of Object.entries(value)) {
        if (
          this.stateManager.getIdentifierTypeForKeyInContext(key, context) === identifierType &&
          typeof nestedValue === 'string' &&
          !seen.has(nestedValue)
        ) {
          seen.add(nestedValue);
          ids.push(nestedValue);
        } else {
          visit(nestedValue);
        }
      }
    };

    visit(source);

    return ids;
  }

  getServiceBaseUrl(serviceName) {
    const url = SERVICE_MAP[serviceName]?.baseUrl;
    if (!url) {
      throw new Error(`Unknown service: ${serviceName}`);
    }
    return url;
  }

  getServiceUnixSocket(serviceName) {
    return SERVICE_MAP[serviceName]?.unixSocket || null;
  }

  recordSuccess(step, entry) {
    this.results.passed++;
    this.results.processedLogs.push({
      step,
      entry: entry.toString(),
      timestamp: new Date().toISOString()
    });
  }

  recordFailure(step, entry, details) {
    this.results.failed++;
    this.results.errors.push({
      step,
      entry: entry?.toString(),
      details,
      timestamp: new Date().toISOString()
    });
  }

  async handleThemisEligibilityBatch(incoming) {
    logger.info('Handling Themis-Eligibility_REQUEST batch (temporary workaround)', {
      lenderOrgId: incoming.lenderOrgId,
      requestId: incoming.requestId
    });

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
          e.sourceDestination === 'GATEWAY_THEMIS' &&
          e.lenderOrgId === incoming.lenderOrgId &&
          !this.validator.processedIndices.has(e.index)
        );
        if (responseEntry) {
          this.validator.processedIndices.add(entry.index);
          this.validator.processedIndices.add(responseEntry.index);
          this.recordSuccess('request_validation', entry);
          this.recordSuccess('response_validation', responseEntry);
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
      return await this.fail(`No matching Themis-Eligibility_RESPONSE found for lenderOrgId: ${incoming.lenderOrgId}`);
    }

    const unprocessedCount = allThemisEntries.filter(e => !this.validator.processedIndices.has(e.index)).length;
    if (unprocessedCount === 0) {
      logger.info('All Themis-Eligibility_REQUEST calls processed, advancing log sequence');
      this.validator.currentIndex = Math.max(...this.validator.entries
        .filter(e => e.logTag === 'Themis-Eligibility_REQUEST' && e.source === 'GATEWAY')
        .map(e => e.index)) + 1;
    }

    return {
      success: true,
      payload: transformRequest(responseEntry.payload, responseEntry.logTag),
      batchProcessed: true
    };
  }

  async handleThemisKFSReq(incoming) {
    logger.info('Handling Themis-KFS_REQUEST', {
      lenderOrgId: incoming.lenderOrgId,
      requestId: incoming.requestId
    });

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
          synthesized: true
        };
      }

      return await this.fail(`No matching Themis-KFS_RESPONSE found for lenderOrgId: ${incoming.lenderOrgId}`);
    }

    if (!this.validator.processedIndices.has(requestEntry.index)) {
      this.validator.processedIndices.add(requestEntry.index);
      this.recordSuccess('request_validation', requestEntry);
    }
    if (!this.validator.processedIndices.has(responseEntry.index)) {
      this.validator.processedIndices.add(responseEntry.index);
      this.recordSuccess('response_validation', responseEntry);
    }

    logger.info('Marked Themis-KFS pair as processed', {
      requestIndex: requestEntry.index,
      responseIndex: responseEntry.index,
      lenderOrgId: requestEntry.lenderOrgId
    });

    const comparison = this.comparePayloads(requestEntry.payload, incoming.payload, incoming.logTag);
    if (!comparison.match) {
      logger.warn('Themis-KFS payload mismatch tolerated', {
        lenderOrgId: incoming.lenderOrgId,
        requestId: incoming.requestId,
        differences: comparison.differences
      });
    }

    const remainingUnprocessed = kfsRequestEntries.filter(entry => !this.validator.processedIndices.has(entry.index)).length;
    if (remainingUnprocessed === 0) {
      logger.info('All Themis-KFS_REQUEST calls processed, advancing log sequence');
      this.validator.currentIndex = Math.max(...this.validator.entries
        .filter(e => e.logTag === 'Themis-KFS_REQUEST' && e.source === 'GATEWAY')
        .map(e => e.index)) + 1;
    }

    return {
      success: true,
      payload: transformRequest(responseEntry.payload, responseEntry.logTag),
      batchProcessed: true
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

  recordFlowFailure(failureInfo) {
    this.flowFailures.push(failureInfo);
    
    if (this.reportGenerator && this.orderId) {
      this.reportGenerator.recordFlowFailure(this.orderId, failureInfo);
    }
  }

  async fail(error, details = null) {
    logger.error('Orchestrator failed', { error, details });
    this.isRunning = false;
    this.failureReason = error;
    this.recordFailure('orchestrator_failure', null, { error, details });
    throw new Error(error);
  }

  isFailed() {
    return this.failureReason !== null;
  }

  getResults() {
    return {
      ...this.results,
      progress: this.validator.getProgress(),
      state: this.stateManager.getState(),
      flowFailures: this.flowFailures,
      failedFlowRequests: this.flowFailures,
      bufferFailures: this.flowFailures,
      failedBufferRequests: this.flowFailures,
      failureReason: this.failureReason
    };
  }

  isComplete() {
    return this.validator.isComplete();
  }
}

export default ReplayOrchestrator;
function extractOpportunityId(value) {
  if (!value || typeof value !== 'object') {
    return null;
  }

  if (typeof value.opportunityid === 'string' && value.opportunityid) {
    return value.opportunityid;
  }

  if (value.payload && typeof value.payload === 'object') {
    return extractOpportunityId(value.payload);
  }

  if (value.body && typeof value.body === 'object') {
    return extractOpportunityId(value.body);
  }

  return null;
}
