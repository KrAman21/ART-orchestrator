import { StateManager } from './services/state-manager.js';
import { LogSequenceValidator } from './services/log-sequence-validator.js';
import { compareLog } from './services/comparator.js';
import { logger } from './utils/logger.js';
import { getApiForLogTag as getApiFromConfig, getEndpointConfig, SERVICE_MAP, SKIP_DESTINATIONS, isAsyncParallelApi, LENDER_ORG_ID_TO_ID_MAP, normalizeSourceDestination } from './config.js';
import { transformRequest } from './services/request-transformer.js';

import { SeedDataManager } from './onboarding/seed-data-manager.js';
import { RetryHandler } from './incoming-handlers/retry-handler.js';
import { OutOfOrderHandler } from './incoming-handlers/out-of-order-handler.js';
import { LogProcessor } from './processing/log-processor.js';
import { RequestForwarder } from './processing/request-forwarder.js';
import { AsyncTracker } from './async-tracking/async-tracker.js';
import { WebhookManager } from './webhook/webhook-manager.js';

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
      processedLogs: []
    };

    this.pendingExternalRequests = new Map();
    this.earlyExternalResponses = new Map();
    this.requestToExternalCalls = new Map();
    this.triggeredWebhooks = new Set();
    this.asyncCallTracker = new Map();
    this.pendingPostResponseWebhooks = new Map();

    this.isRunning = false;
    this.failureReason = null;
    this.reportGenerator = config.reportGenerator || null;
    this.orderId = config.orderId || null;
    this.bufferFailures = [];

    this.loadLogs(logs);
  }

  loadLogs(logs) {
    this.logs = logs;
    this.validator = new LogSequenceValidator(logs);
    this.seedDataManager = new SeedDataManager(logs);
    this.resetState();
  }

  resetState() {
    this.results = {
      passed: 0,
      failed: 0,
      errors: [],
      processedLogs: []
    };

    this.pendingExternalRequests.clear();
    this.earlyExternalResponses.clear();
    this.requestToExternalCalls.clear();
    this.triggeredWebhooks.clear();
    this.asyncCallTracker.clear();
    this.pendingPostResponseWebhooks.clear();

    this.isRunning = false;

    this._initHandlers();
  }

  _initHandlers() {
    this.retryHandler = new RetryHandler({
      validator: this.validator,
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
        isAsyncParallelCall: this.isAsyncParallelCall.bind(this)
      }
    });

    this.webhookManager = new WebhookManager({
      validator: this.validator,
      logger: logger,
      config: this.config,
      triggeredWebhooks: this.triggeredWebhooks
    });

    this.asyncTracker = new AsyncTracker({
      asyncCallTracker: this.asyncCallTracker,
      pendingExternalRequests: this.pendingExternalRequests,
      triggeredWebhooks: this.triggeredWebhooks,
      logger: logger,
      validator: this.validator,
      config: this.config,
      callbacks: {
        triggerWebhooks: this.webhookManager.triggerWebhooks.bind(this.webhookManager),
        triggerAppWebhooksAfterResponse: this.triggerAppWebhooksAfterResponse.bind(this),
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
        triggerWebhooks: this.webhookManager.triggerWebhooks.bind(this.webhookManager),
        trackAsyncCompletion: this.trackAsyncCompletion.bind(this),
        fail: this.fail.bind(this),
        recordBufferFailure: this.recordBufferFailure.bind(this)
      }
    });

    this.requestForwarder.pendingExternalRequests = this.pendingExternalRequests;
    this.requestForwarder.earlyExternalResponses = this.earlyExternalResponses;
    this.requestForwarder.pendingPostResponseWebhooks = this.pendingPostResponseWebhooks;

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

  async onboardSeedData(merchantId, lenderOrgIdToIdMap, lineDetails) {
    return this.seedDataManager.onboardSeedData(merchantId, lenderOrgIdToIdMap, lineDetails);
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

    await this.clearLspData(merchantId, orderId);
    // Set Onboarding data for the merchant to ensure LSP is ready for the replay session
    await this.onboardSeedData(merchantId, lenderOrgIdToIdMap, lineDetails);

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
    const shouldOrchestratorInitiate = orchestratorInitiatedSources.includes(entry.source);

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

    logger.info('ORCH_RECEIVING', {
      source: incoming.source,
      destination: incoming.destination,
      api: incoming.api,
      requestId: incoming.requestId,
      payload: incoming.payload,
      headers: incoming.headers,
      timestamp: new Date().toISOString()
    });

    if (incoming.logTag === 'Themis-Eligibility_REQUEST' && incoming.source === 'GATEWAY' && (incoming.destination === 'LENDER' || incoming.destination === 'LSP' || incoming.destination === 'THEMIS')) {
      return await this.handleThemisEligibilityBatch(incoming);
    }

    if(incoming.logTag === 'Themis-KFS_REQUEST'){
      logger.info('Received request for THEMIS-KFS, checking if it should be mocked', {
        source: incoming.source,
        destination: incoming.destination,
        api: incoming.api,
        logTag: incoming.logTag
      });
      return await this.handleThemisKFSReq(incoming);
    }

    const expectedEntry = this.validator.getCurrentEntry();

    if (!expectedEntry) {
      return await this.fail('No more entries to process - unexpected request');
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

    const validation = this.validator.validateIncomingRequest({
      source: normalizedIncoming.source,
      destination: normalizedIncoming.destination,
      logTag: normalizedIncoming.logTag,
      isRequest: true,
      requestId: normalizedIncoming.requestId,
      lenderOrgId: normalizedIncoming.lenderOrgId
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
      logTag: expectedEntry.logTag
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
      logger.error('ORCH_PAYLOAD_MISMATCH', {
        logTag: incoming.logTag,
        differences: comparison.differences,
        expectedFull: expectedPayload,
        actualFull: incoming.payload
      });
      return await this.fail('Payload comparison failed', comparison.differences);
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
    const entriesToSearch = searchAll
      ? this.validator.entries
      : this.validator.entries.slice(requestEntry.index + 1);

    for (const entry of entriesToSearch) {
      if (!entry.isResponse) continue;
      if (this.matchesRequestContext(requestEntry, entry)) {
        return entry;
      }
    }
    return null;
  }

  findAllCorrespondingResponses(requestEntry) {
    const responses = [];
    for (const entry of this.validator.entries) {
      if (!entry.isResponse) continue;
      if (this.matchesRequestContext(requestEntry, entry)) {
        responses.push(entry);
      }
    }
    return responses;
  }

  matchesRequestContext(requestEntry, responseEntry) {
    const requestTag = requestEntry.logTag;
    const responseTag = responseEntry.logTag;

    if (requestTag !== responseTag) {
      const requestBase = requestTag.replace(/_REQUEST$/, '').replace(/_INCOMING$/, '');
      const responseBase = responseTag.replace(/_RESPONSE$/, '').replace(/_OUTGOING$/, '');
      if (requestBase !== responseBase) {
        return false;
      }
    }

    if (requestEntry.loanApplicationId && responseEntry.loanApplicationId) {
      if (requestEntry.loanApplicationId !== responseEntry.loanApplicationId) {
        return false;
      }
    }

    if (requestEntry.lenderOrgId && responseEntry.lenderOrgId) {
      if (requestEntry.lenderOrgId !== responseEntry.lenderOrgId) {
        return false;
      }
    }

    const expectedSource = requestEntry.destination;
    const expectedDest = requestEntry.source;

    if (responseEntry.source !== expectedSource || responseEntry.destination !== expectedDest) {
      return false;
    }

    return true;
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

  async triggerWebhooks(webhooks) {
    return this.webhookManager.triggerWebhooks(webhooks);
  }

  async triggerAppWebhooksAfterResponse() {
    return this.webhookManager.triggerAppWebhooksAfterResponse();
  }

  comparePayloads(expected, actual, logTag) {
    return compareLog(expected, actual, logTag);
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
      this.currentIndex = Math.max(...this.validator.entries
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

    const allThemisEntries = this.validator.entries.filter(entry =>
      entry.logTag === 'Themis-KFS_REQUEST' &&
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
          e.logTag === 'Themis-KFS_RESPONSE' &&
          e.sourceDestination === 'GATEWAY_THEMIS' &&
          e.lenderOrgId === incoming.lenderOrgId &&
          !this.validator.processedIndices.has(e.index)
        );
        if (responseEntry) {
          this.validator.processedIndices.add(entry.index);
          this.validator.processedIndices.add(responseEntry.index);
          this.recordSuccess('request_validation', entry);
          this.recordSuccess('response_validation', responseEntry);
          logger.info('Marked Themis-KFS pair as processed', {
            requestIndex: entry.index,
            responseIndex: responseEntry.index,
            lenderOrgId: entry.lenderOrgId
          });
        }
        break;
      }
    }

    if (!responseEntry) {
      return await this.fail(`No matching Themis-KFS_RESPONSE found for lenderOrgId: ${incoming.lenderOrgId}`);
    }

    const unprocessedCount = allThemisEntries.filter(e => !this.validator.processedIndices.has(e.index)).length;
    if (unprocessedCount === 0) {
      logger.info('All Themis-KFS_REQUEST calls processed, advancing log sequence');
      this.currentIndex = Math.max(...this.validator.entries
        .filter(e => e.logTag === 'Themis-KFS_REQUEST' && e.source === 'GATEWAY')
        .map(e => e.index)) + 1;
    }

    return {
      success: true,
      payload: transformRequest(responseEntry.payload, responseEntry.logTag),
      batchProcessed: true
    };
  }

  recordBufferFailure(failureInfo) {
    this.bufferFailures.push(failureInfo);
    
    if (this.reportGenerator && this.orderId) {
      this.reportGenerator.recordBufferFailure(this.orderId, failureInfo);
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
      bufferFailures: this.bufferFailures,
      failureReason: this.failureReason
    };
  }

  isComplete() {
    return this.validator.isComplete();
  }
}

export default ReplayOrchestrator;
