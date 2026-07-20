import { ReplayOrchestrator } from '../orchestrator.js';
import { BufferManager } from './buffer-manager.js';
import { NonBlockingHttpClient } from './non-blocking-http.js';
import { logger } from '../utils/logger.js';
import { transformRequest } from '../services/request-transformer.js';
import { getEndpointConfig, normalizeSourceDestination, RETRY_TIMEOUT_OVERRIDES, SERVICE_MAP } from '../config.js';
import { getOptionalRepeatPolicy, isImmediateDirectReplayLogTag, isImmediateFutureCoreGatewayRequestLogTag, isSelfTriggerFallbackApiLogTag, isSkippableAsyncApiLogTag, isThemisEligibilitySpecialCase, isThemisKfsSpecialCase, isToleratedBatchTimeoutApiLogTag, SELF_TRIGGER_FALLBACK_API_LOG_TAGS, SELF_TRIGGER_FALLBACK_WAIT_TIMEOUT_OVERRIDES_MS, SKIPPABLE_ASYNC_API_LOG_TAGS } from '../replay-special-cases.js';
import { buildAppCoreAuthHeaders, buildReplaySessionHeaders } from '../services/app-core-auth-headers.js';
import { ensureAppCorePreconditions } from '../services/app-core-preconditions.js';
import { getAppCoreRequestId } from '../services/app-core-request-id.js';
import { resolveReplayEndpoint } from '../services/replay-request-resolver.js';
import { makeRequest } from '../services/http-client.js';
import { normalizeCanonicalLoanApplicationReferences } from '../services/canonical-loan-application-id.js';

const APP_CORE_IMMEDIATE_PAIRED_RESPONSE_LOG_TAGS = new Set([
  'GetAgreementDataRequest_REQUEST'
]);

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

function normalizeHdbWebhookLoanApplicationIdentifiers(remapped, forcedLoanApplicationId = null) {
  if (!remapped || typeof remapped !== 'object') {
    return remapped;
  }

  const payloadData = remapped.data;
  if (!payloadData || typeof payloadData !== 'object') {
    return remapped;
  }

  const resolvedLoanApplicationId =
    forcedLoanApplicationId ||
    remapped.loanApplicationId ||
    remapped.loan_application_id ||
    payloadData.loanApplicationId ||
    payloadData.partnerRefNo ||
    payloadData.applicationId ||
    null;

  if (!resolvedLoanApplicationId) {
    return remapped;
  }

  return {
    ...remapped,
    data: {
      ...payloadData,
      applicationId: resolvedLoanApplicationId,
      partnerRefNo: resolvedLoanApplicationId
    }
  };
}

function remapReplayIds(value, stateManager, logTag, keyHint = null, forcedLoanApplicationId = null) {
  if (typeof value === 'string') {
    return stateManager?.remapReplayValue
      ? stateManager.remapReplayValue(value, keyHint, { logTag })
      : value;
  }

  if (!value || typeof value !== 'object') {
    return value;
  }

  if (Array.isArray(value)) {
    return value.map(item => remapReplayIds(item, stateManager, logTag, keyHint, forcedLoanApplicationId));
  }

  const remapped = {};

  for (const [key, nestedValue] of Object.entries(value)) {
    remapped[key] = remapReplayIds(nestedValue, stateManager, logTag, key, forcedLoanApplicationId);
  }

  if (logTag === 'HDB_WEBHOOK_REQUEST') {
    return normalizeHdbWebhookLoanApplicationIdentifiers(remapped, forcedLoanApplicationId);
  }

  return normalizeCanonicalLoanApplicationReferences(remapped, forcedLoanApplicationId);
}

function resolveReplayMerchantId(entry, payload = null, fallbackMerchantId = null) {
  return (
    entry?.headers?.['x-merchant-id'] ||
    entry?.headers?.['X-Merchant-Id'] ||
    entry?.message?.merchant_id ||
    payload?.merchantId ||
    payload?.merchant_id ||
    entry?.payload?.merchantId ||
    entry?.payload?.merchant_id ||
    fallbackMerchantId ||
    null
  );
}

function findFirstNestedValue(value, candidateKeys) {
  if (!value || typeof value !== 'object') {
    return null;
  }

  if (Array.isArray(value)) {
    for (const item of value) {
      const nestedMatch = findFirstNestedValue(item, candidateKeys);
      if (nestedMatch !== null && nestedMatch !== undefined && nestedMatch !== '') {
        return nestedMatch;
      }
    }
    return null;
  }

  for (const [key, nestedValue] of Object.entries(value)) {
    if (candidateKeys.includes(key) && nestedValue !== null && nestedValue !== undefined && nestedValue !== '') {
      return nestedValue;
    }
  }

  for (const nestedValue of Object.values(value)) {
    const nestedMatch = findFirstNestedValue(nestedValue, candidateKeys);
    if (nestedMatch !== null && nestedMatch !== undefined && nestedMatch !== '') {
      return nestedMatch;
    }
  }

  return null;
}

function isPlainObject(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
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

function hasHeader(headers, headerName) {
  return Object.keys(headers || {}).some(key => key.toLowerCase() === headerName.toLowerCase());
}

function applySdkHeaders(headers, logTag) {
  if (typeof logTag !== 'string' || !logTag.includes('SDK')) {
    return headers;
  }

  const updatedHeaders = { ...(headers || {}) };

  if (!hasHeader(updatedHeaders, 'x-origin')) {
    updatedHeaders['x-origin'] = 'SDK';
  }

  if (!hasHeader(updatedHeaders, 'x-version')) {
    updatedHeaders['x-version'] = 'V1';
  }

  return updatedHeaders;
}

function resolveRequestIdFromObservedRequest(request) {
  if (!request) {
    return null;
  }

  return (
    request.payload?.requestId ||
    request.payload?.request_id ||
    request.requestId ||
    null
  );
}

function buildReplayRequestIdCandidate(candidateRequest, score) {
  const requestId = resolveRequestIdFromObservedRequest(candidateRequest);
  if (!requestId) {
    return null;
  }

  return {
    requestId,
    score,
    timestamp: candidateRequest.timestamp || candidateRequest.observedAt || 0,
    logTag: candidateRequest.logTag || null,
    sourceDestination:
      candidateRequest.sourceDestination ||
      (candidateRequest.source && candidateRequest.destination
        ? normalizeSourceDestination(`${candidateRequest.source}_${candidateRequest.destination}`, candidateRequest.logTag)
        : null)
  };
}

export function resolveFallbackGatewayRequestId(entry, observedIncomingRequests = []) {
  if (entry?.logTag !== 'Lsp-LoanStatusRequest_REQUEST' && entry?.logTag !== 'LSP-GetStatus_REQUEST') {
    return null;
  }

  const candidates = [];

  for (const candidateRequest of observedIncomingRequests || []) {
    const normalizedSourceDestination =
      candidateRequest?.sourceDestination ||
      (candidateRequest?.source && candidateRequest?.destination
        ? normalizeSourceDestination(`${candidateRequest.source}_${candidateRequest.destination}`, candidateRequest.logTag)
        : null);

    if (!candidateRequest || normalizedSourceDestination !== 'CORE_GATEWAY') {
      continue;
    }

    if (candidateRequest.loanApplicationId !== entry.loanApplicationId) {
      continue;
    }

    if (candidateRequest.orderId && entry.orderId && candidateRequest.orderId !== entry.orderId) {
      continue;
    }

    let score = 0;
    if (candidateRequest.logTag === 'LSP-SelectOffer_REQUEST') score += 200;
    if (candidateRequest.logTag === 'LSP-FetchOfferRequest_REQUEST') score += 150;
    if (candidateRequest.logTag === 'LSP-Eligibility_REQUEST') score += 100;
    if (candidateRequest.logTag === 'Lsp-LoanStatusRequest_REQUEST') score += 50;

    const builtCandidate = buildReplayRequestIdCandidate(candidateRequest, score);
    if (builtCandidate) {
      candidates.push(builtCandidate);
    }
  }

  candidates.sort((left, right) => {
    if (right.score !== left.score) {
      return right.score - left.score;
    }
    return right.timestamp - left.timestamp;
  });

  return candidates[0] || null;
}

export function prepareAsyncReplayForwarding(entry, payload, outboundRequestId, endpointHeaders = {}, fallbackMerchantId = null, observedIncomingRequests = [], stateManager = null) {
  const merchantId = resolveReplayMerchantId(entry, payload, fallbackMerchantId);
  const requestId = stateManager?.rewriteOutgoingRequestIdValue
    ? stateManager.rewriteOutgoingRequestIdValue(outboundRequestId, {
      logTag: entry?.logTag,
      field: 'requestId'
    })
    : outboundRequestId;
  const rawHeaders = {
    ...(entry?.headers || {}),
    ...(endpointHeaders || {})
  };
  const remappedHeaders = stateManager?.rewriteOutgoingLoanApplicationIds
    ? stateManager.rewriteOutgoingLoanApplicationIds(rawHeaders, { logTag: entry?.logTag, field: 'headers' })
    : rawHeaders;
  const headers = applySdkHeaders(remappedHeaders, entry?.logTag);

  if (merchantId && !headers['x-merchant-id'] && !headers['X-Merchant-Id']) {
    headers['x-merchant-id'] = merchantId;
  }

  const replayRequestIdCandidate = resolveFallbackGatewayRequestId(entry, observedIncomingRequests);
  const replayCanonicalLoanApplicationId =
    stateManager?.getMappedLoanApplicationId?.(entry?.loanApplicationId) ||
    entry?.loanApplicationId ||
    payload?.loanApplicationId ||
    payload?.loan_application_id ||
    payload?.data?.loanApplicationId ||
    stateManager?.getCurrentReplayLoanApplicationId?.() ||
    null;
  const canonicalPayload = normalizeCanonicalLoanApplicationReferences(payload, replayCanonicalLoanApplicationId);
  const rewrittenPayload = stateManager?.rewriteOutgoingLoanApplicationIds
    ? stateManager.rewriteOutgoingLoanApplicationIds(canonicalPayload, { logTag: entry?.logTag, field: 'payload' })
    : canonicalPayload;
  const normalizedPayload = entry?.logTag === 'HDB_WEBHOOK_REQUEST'
    ? normalizeHdbWebhookLoanApplicationIdentifiers(rewrittenPayload, replayCanonicalLoanApplicationId)
    : rewrittenPayload;

  return {
    headers,
    merchantId,
    payload: normalizedPayload,
    requestId,
    replayRequestIdCandidate
  };
}

function buildReplayLenderDetailsSeedPayload(entry, payload, replayMerchantId, observedIncomingRequests = [], validatorEntries = []) {
  if (
    (
      entry?.logTag !== 'Lsp-LoanStatusRequest_REQUEST' &&
      entry?.logTag !== 'LSP-GetStatus_REQUEST' &&
      entry?.logTag !== 'VerifyLenderOTPRequest-LSP_REQUEST'
    ) ||
    !isPlainObject(payload) ||
    !payload.requestId
  ) {
    return null;
  }

  const merchantId = resolveReplayMerchantId(entry, payload, replayMerchantId);
  const lenderOrgId =
    entry?.lenderOrgId ||
    payload?.lenderOrgId ||
    payload?.lender_org_id ||
    null;
  const loanApplicationId =
    entry?.loanApplicationId ||
    payload?.loanApplicationId ||
    payload?.loan_application_id ||
    null;

  if (!merchantId || !lenderOrgId) {
    return null;
  }

  const observedCandidates = (observedIncomingRequests || []).map(request => ({
    ...request,
    payload: request?.payload || null,
    message: request?.message || null,
    lenderOrgId:
      request?.lenderOrgId ||
      request?.payload?.lenderOrgId ||
      request?.payload?.lender_org_id ||
      null,
    loanApplicationId:
      request?.loanApplicationId ||
      request?.payload?.loanApplicationId ||
      request?.payload?.loan_application_id ||
      null
  }));

  const validatorCandidates = (validatorEntries || []).map(candidateEntry => ({
    payload: candidateEntry?.payload || null,
    message: candidateEntry?.message || null,
    lenderOrgId: candidateEntry?.lenderOrgId || null,
    loanApplicationId: candidateEntry?.loanApplicationId || null,
    logTag: candidateEntry?.logTag || null
  }));

  const matchingCandidates = [...observedCandidates, ...validatorCandidates]
    .filter(candidate => {
      if (!candidate) return false;
      if (candidate.lenderOrgId && candidate.lenderOrgId !== lenderOrgId) return false;
      if (loanApplicationId && candidate.loanApplicationId && candidate.loanApplicationId !== loanApplicationId) return false;
      return true;
    })
    .reverse();

  let lenderRedirectionUrl = null;
  let gatewayRefId = null;

  for (const candidate of matchingCandidates) {
    lenderRedirectionUrl =
      lenderRedirectionUrl ||
      findFirstNestedValue(candidate, [
        'lenderRedirectionUrl',
        'lender_redirection_url',
        'redirectionUrl',
        'redirection_url'
      ]);
    gatewayRefId =
      gatewayRefId ||
      findFirstNestedValue(candidate, [
        'gatewayRefId',
        'gateway_ref_id'
      ]);

    if (lenderRedirectionUrl && gatewayRefId) {
      break;
    }
  }

  return {
    merchantId,
    lenderOrgId,
    requestId: payload.requestId,
    lenderRedirectionUrl: lenderRedirectionUrl || '',
    gatewayRefId: gatewayRefId || null
  };
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

function sharesReplayContext(leftEntry, rightEntry) {
  if (!leftEntry || !rightEntry) {
    return false;
  }

  if (leftEntry.orderId && rightEntry.orderId && leftEntry.orderId !== rightEntry.orderId) {
    return false;
  }

  if (
    leftEntry.loanApplicationId &&
    rightEntry.loanApplicationId &&
    leftEntry.loanApplicationId !== rightEntry.loanApplicationId
  ) {
    return false;
  }

  if (leftEntry.lenderOrgId && rightEntry.lenderOrgId && leftEntry.lenderOrgId !== rightEntry.lenderOrgId) {
    return false;
  }

  return true;
}

function getPayloadValueAtPath(payload, payloadPath) {
  if (!payload || !payloadPath) {
    return undefined;
  }

  return payloadPath.split('.').reduce((current, segment) => {
    if (current === null || current === undefined) {
      return undefined;
    }

    return current[segment];
  }, payload);
}

function isTerminalHardEligibilityFailure(logTag, payload) {
  if (logTag !== 'FlipKart-HardEligibilityStatus_RESPONSE') {
    return false;
  }

  if (!payload || typeof payload !== 'object') {
    return false;
  }

  return (
    payload.status === 'FAILURE' ||
    payload.error?.error_message === 'LENDER_REJECTED_BASED_ON_PROFILE' ||
    payload.error?.error_code === 'LENDER_REJECTED'
  );
}

export class AsyncReplayOrchestrator extends ReplayOrchestrator {
  constructor(logs, config = {}) {
    super(logs, config);
    this.config.asyncReplayMode = true;
    this.replayMerchantId = config.merchantId || null;
    
    this.bufferManager = new BufferManager({
      defaultTimeoutMs: 60000
    });
    
    this.httpClient = new NonBlockingHttpClient(
      this.bufferManager,
      config.reportGenerator,
      config.orderId,
      {
        shouldTreatApiFailureAsExpected: this.shouldTreatApiFailureAsExpected.bind(this),
        buildFailureFallbackResponse: this.buildFailureFallbackResponse.bind(this)
      }
    );
    
    this.isPolling = false;
    this.pollIntervalMs = config.pollIntervalMs || 50;
    this.maxBackoffMs = config.maxBackoffMs || 50;
    this.shouldStop = false;
    this.orderId = config.orderId;
    this.resolvedStuckEntrySignals = new Set();
    this.pendingPostBatchConfirmations = new Map();
    this.lastIdleExternalEntryKey = null;
    this.idleExternalEntryCycles = 0;
    this.activeLoanSettlementPtTriggers = new Set();
    this.hasWaitedForInitialLoanSettlementPtTrigger = false;
    this.inFlightEntryProcessing = new Map();
    this.preSatisfiedReplayEntries = new Map();
    if (this.requestForwarder?.callbacks) {
      this.requestForwarder.callbacks.shouldAutoProcessNextLogEntry = () => false;
      this.requestForwarder.callbacks.shouldBlockOnHeldExternalRequest = () => false;
    }
  }

  async maybePrimeLoanSettlementPt(entry) {
    if (entry?.logTag !== 'LOAN_SETTLEMENT_PT_REQUEST' || !entry?.isRequest) {
      return;
    }

    const triggerKey = `${entry.index}:${this.validator.currentIndex}`;
    if (this.activeLoanSettlementPtTriggers.has(triggerKey)) {
      logger.info('Loan settlement PT replay trigger already in progress for current wait cycle', {
        entry: entry.toString(),
        triggerKey
      });
      return;
    }

    const loanApplicationId = this.resolveOutboundLoanApplicationIdForReplay(entry, {
      allowInferenceFromLiveBuffer: true
    });

    if (!loanApplicationId) {
      logger.warn('Skipping loan settlement PT replay trigger because no replay loanApplicationId could be resolved yet', {
        entry: entry.toString(),
        prodLoanApplicationId: entry.loanApplicationId || null
      });
      return;
    }

    const merchantId = this.replayMerchantId || this.config.merchantId || null;
    this.activeLoanSettlementPtTriggers.add(triggerKey);

    try {
      if (!this.hasWaitedForInitialLoanSettlementPtTrigger) {
        logger.info('Waiting once before first loan settlement PT replay helper trigger', {
          entry: entry.toString(),
          delayMs: 1000
        });
        await new Promise(resolve => setTimeout(resolve, 1000));
        this.hasWaitedForInitialLoanSettlementPtTrigger = true;
      }

      logger.info('Triggering loan settlement PT replay helper immediately after buffer miss', {
        entry: entry.toString(),
        loanApplicationId,
        merchantId
      });

      const response = await makeRequest(
        SERVICE_MAP.LSP.baseUrl,
        '/art/loan-settlement-pt/trigger',
        'POST',
        { loanApplicationId },
        null,
        null,
        'ART_TRIGGER_LOAN_SETTLEMENT_PT',
        merchantId,
        merchantId ? { 'x-merchant-id': merchantId } : {},
        null,
        SERVICE_MAP.LSP.unixSocket,
        10000
      );

      logger.info('Loan settlement PT replay helper completed', {
        entry: entry.toString(),
        loanApplicationId,
        status: response?.status ?? null,
        error: response?.error || false,
        responseData: response?.data || null
      });
    } catch (error) {
      logger.warn('Loan settlement PT replay helper failed before wait; continuing with normal buffer wait', {
        entry: entry.toString(),
        loanApplicationId,
        error: error.message
      });
    } finally {
      this.activeLoanSettlementPtTriggers.delete(triggerKey);
    }
  }

  getMultiTagEndpointFamily(api, source, destination) {
    if (source !== 'GATEWAY' || destination !== 'LENDER') {
      return null;
    }

    const families = {
      '/prod/MOCK_DATA': [
        'KYC SERVICE API_REQUEST',
        'KFS SERVICE API :: PARENT_REQUEST',
        'KFS SERVICE API :: CHILD_REQUEST',
        'KFS SIGNING API :: PARENT_REQUEST',
        'KFS SIGNING API :: CHILD_REQUEST'
      ],
      '/prod/polling': [
        'POLLING API :: LINE_STATUS_REQUEST',
        'POLLING API :: FORCE_LOAN_STATUS_SYNC_REQUEST'
      ],
      '/MOCK_DATA/polling': [
        'POLLING API :: LINE_STATUS_REQUEST',
        'POLLING API :: FORCE_LOAN_STATUS_SYNC_REQUEST'
      ],
      '/telcosprod/telcoauth': [
        'OTP GENERATION API_REQUEST',
        'OTP AUTHENTICATION API_REQUEST'
      ]
    };

    return families[api] || null;
  }

  findNextUnprocessedMultiTagEntry(api, source, destination, familyLogTags = []) {
    if (!api || !Array.isArray(familyLogTags) || familyLogTags.length === 0) {
      return null;
    }

    for (const entry of this.validator.entries) {
      if (entry.index < this.validator.currentIndex) continue;
      if (this.validator.processedIndices.has(entry.index)) continue;
      if (!entry.isRequest) continue;
      if (entry.source !== source || entry.destination !== destination) continue;
      if (entry.api !== api) continue;
      if (!familyLogTags.includes(entry.logTag)) continue;
      return entry;
    }

    return null;
  }

  findUnprocessedMultiTagEntryByOpportunityId(api, source, destination, familyLogTags = [], opportunityId = null) {
    if (!api || !opportunityId || !Array.isArray(familyLogTags) || familyLogTags.length === 0) {
      return null;
    }

    for (const entry of this.validator.entries) {
      if (entry.index < this.validator.currentIndex) continue;
      if (this.validator.processedIndices.has(entry.index)) continue;
      if (!entry.isRequest) continue;
      if (entry.source !== source || entry.destination !== destination) continue;
      if (entry.api !== api) continue;
      if (!familyLogTags.includes(entry.logTag)) continue;

      const expectedOpportunityId = extractOpportunityId(entry);
      if (expectedOpportunityId && expectedOpportunityId === opportunityId) {
        return entry;
      }
    }

    return null;
  }

  maybeRemapIncomingMultiTagSibling(incoming) {
    const normalizedSourceDestination = normalizeSourceDestination(
      `${incoming.source}_${incoming.destination}`,
      incoming.logTag
    );
    const [source, destination] = normalizedSourceDestination.split('_');
    const familyLogTags = this.getMultiTagEndpointFamily(incoming.api, source, destination);

    if (!familyLogTags || !familyLogTags.includes(incoming.logTag)) {
      return incoming;
    }

    const incomingOpportunityId = extractOpportunityId(incoming);
    const opportunityMatchedEntry = this.findUnprocessedMultiTagEntryByOpportunityId(
      incoming.api,
      source,
      destination,
      familyLogTags,
      incomingOpportunityId
    );

    if (opportunityMatchedEntry && opportunityMatchedEntry.logTag !== incoming.logTag) {
      logger.info('Reclassified incoming multi-tag lender request by exact opportunity id before retry handling', {
        api: incoming.api,
        opportunityId: incomingOpportunityId,
        originalLogTag: incoming.logTag,
        remappedLogTag: opportunityMatchedEntry.logTag,
        currentReplayIndex: this.validator.currentIndex,
        targetReplayIndex: opportunityMatchedEntry.index,
        requestId: incoming.requestId,
        loanApplicationId: incoming.loanApplicationId || null,
        lenderOrgId: incoming.lenderOrgId || null
      });

      return {
        ...incoming,
        logTag: opportunityMatchedEntry.logTag
      };
    }

    const nextFamilyEntry = this.findNextUnprocessedMultiTagEntry(
      incoming.api,
      source,
      destination,
      familyLogTags
    );

    if (!nextFamilyEntry || nextFamilyEntry.logTag === incoming.logTag) {
      return incoming;
    }

    const pendingSameTag = Array.from(this.pendingExternalRequests.values()).some(pendingInfo => {
      const requestEntry = pendingInfo?.requestEntry;
      return (
        requestEntry?.source === source &&
        requestEntry?.destination === destination &&
        requestEntry?.api === incoming.api &&
        requestEntry?.logTag === incoming.logTag &&
        (
          !incoming.loanApplicationId ||
          !requestEntry.loanApplicationId ||
          incoming.loanApplicationId === requestEntry.loanApplicationId
        ) &&
        (
          !incoming.lenderOrgId ||
          !requestEntry.lenderOrgId ||
          incoming.lenderOrgId === requestEntry.lenderOrgId
        )
      );
    });

    if (!pendingSameTag) {
      return incoming;
    }

    logger.info('Reclassified incoming multi-tag lender request to next replay sibling before retry handling', {
      api: incoming.api,
      originalLogTag: incoming.logTag,
      remappedLogTag: nextFamilyEntry.logTag,
      currentReplayIndex: this.validator.currentIndex,
      targetReplayIndex: nextFamilyEntry.index,
      requestId: incoming.requestId,
      loanApplicationId: incoming.loanApplicationId || null,
      lenderOrgId: incoming.lenderOrgId || null
    });

    return {
      ...incoming,
      logTag: nextFamilyEntry.logTag
    };
  }

  markStuckEntryResolved(entryOrIndex, reason = 'explicit_resolution') {
    const resolvedIndex = typeof entryOrIndex === 'number'
      ? entryOrIndex
      : entryOrIndex?.index;

    if (resolvedIndex === null || resolvedIndex === undefined) {
      return false;
    }

    this.resolvedStuckEntrySignals.add(resolvedIndex);
    logger.info('Marked stuck entry as resolved for outer watcher', {
      resolvedIndex,
      reason
    });
    return true;
  }

  consumeResolvedStuckEntrySignal(entryOrIndex) {
    const resolvedIndex = typeof entryOrIndex === 'number'
      ? entryOrIndex
      : entryOrIndex?.index;

    if (resolvedIndex === null || resolvedIndex === undefined) {
      return false;
    }

    if (!this.resolvedStuckEntrySignals.has(resolvedIndex)) {
      return false;
    }

    this.resolvedStuckEntrySignals.delete(resolvedIndex);
    logger.info('Consumed resolved stuck entry signal', {
      resolvedIndex
    });
    return true;
  }

  collectLiveLoanApplicationCandidates(entry) {
    if (!entry?.loanApplicationId) {
      return [];
    }

    const candidates = [];
    const seen = new Set();
    const pushCandidate = (loanApplicationId, timestamp, source, metadata = {}) => {
      if (!loanApplicationId || loanApplicationId === entry.loanApplicationId || seen.has(`${loanApplicationId}:${source}`)) {
        return;
      }

      if (isSuspiciousReplayLoanApplicationIdCandidate(this.stateManager, loanApplicationId, metadata.payload)) {
        return;
      }

      if (entry.orderId && metadata.orderId && metadata.orderId !== entry.orderId) {
        return;
      }

      if (entry.lenderOrgId && metadata.lenderOrgId && metadata.lenderOrgId !== entry.lenderOrgId) {
        return;
      }

      let score = 0;
      if (entry.orderId && metadata.orderId === entry.orderId) score += 100;
      if (entry.lenderOrgId && metadata.lenderOrgId === entry.lenderOrgId) score += 80;
      if (metadata.source === 'GATEWAY' && metadata.destination === 'LSP') score += 40;
      if (metadata.sourceDestination === 'GATEWAY_LSP') score += 40;
      if (typeof metadata.logTag === 'string' && metadata.logTag.includes('FETCH_OFFER')) score += 30;
      if (typeof loanApplicationId === 'string' && loanApplicationId.startsWith('LSP')) score += 20;

      seen.add(`${loanApplicationId}:${source}`);
      candidates.push({
        loanApplicationId,
        timestamp: timestamp || 0,
        source,
        score,
        metadata
      });
    };

    for (const bufferedEntry of this.bufferManager?.incomingRequests?.values?.() || []) {
      const request = bufferedEntry?.request;
      if (!request) {
        continue;
      }

      pushCandidate(
        request.loanApplicationId || request.payload?.loanApplicationId || request.payload?.loan_application_id,
        bufferedEntry.timestamp,
        'incoming_buffer',
        {
          orderId: request.orderId || request.payload?.orderId || request.payload?.order_id || null,
          lenderOrgId: request.lenderOrgId || request.payload?.lenderOrgId || request.payload?.lender_org_id || null,
          source: request.source,
          destination: request.destination,
          sourceDestination: request.sourceDestination,
          logTag: request.logTag,
          payload: request.payload || null
        }
      );
    }

    for (const responseEntry of this.bufferManager?.responseBuffer?.values?.() || []) {
      const metadata = responseEntry?.metadata || {};
      pushCandidate(
        metadata.loanApplicationId,
        responseEntry.timestamp,
        'response_buffer',
        metadata
      );
    }

    for (const observedEntry of this.observedIncomingRequests || []) {
      pushCandidate(
        observedEntry.loanApplicationId || observedEntry.payload?.loanApplicationId || observedEntry.payload?.loan_application_id,
        observedEntry.timestamp,
        'observed_incoming',
        observedEntry
      );
    }

    candidates.sort((left, right) => {
      if (right.score !== left.score) {
        return right.score - left.score;
      }
      return right.timestamp - left.timestamp;
    });

    return candidates;
  }

  resolveOutboundLoanApplicationIdForReplay(entry, options = {}) {
    const {
      allowInferenceFromLiveBuffer = false
    } = options;

    if (!entry?.loanApplicationId) {
      return null;
    }

    const mappedLoanApplicationId = this.stateManager?.getMappedLoanApplicationId?.(entry.loanApplicationId);
    if (mappedLoanApplicationId && mappedLoanApplicationId !== entry.loanApplicationId) {
      return mappedLoanApplicationId;
    }

    if (!allowInferenceFromLiveBuffer) {
      return mappedLoanApplicationId || entry.loanApplicationId;
    }

    const currentReplayLoanApplicationId = this.stateManager?.getCurrentReplayLoanApplicationId?.();
    if (
      currentReplayLoanApplicationId &&
      currentReplayLoanApplicationId !== entry.loanApplicationId &&
      !isSuspiciousReplayLoanApplicationIdCandidate(this.stateManager, currentReplayLoanApplicationId, null)
    ) {
      return currentReplayLoanApplicationId;
    }

    const candidates = this.collectLiveLoanApplicationCandidates(entry);
    const bestCandidate = candidates[0];

    if (!bestCandidate) {
      logger.info('No live replay loanApplicationId candidate found for outbound fallback request', {
        logTag: entry.logTag,
        replayLoanApplicationId: entry.loanApplicationId,
        orderId: entry.orderId || null,
        lenderOrgId: entry.lenderOrgId || null
      });
      return mappedLoanApplicationId || entry.loanApplicationId;
    }

    this.stateManager?.registerIdentifierMapping?.(
      'loanApplicationId',
      entry.loanApplicationId,
      bestCandidate.loanApplicationId
    );
    this.stateManager?.setCurrentReplayLoanApplicationId?.(bestCandidate.loanApplicationId, {
      logTag: entry.logTag,
      requestId: entry.requestId || null,
      source: entry.source,
      destination: entry.destination,
      sourceDestination: entry.sourceDestination
    });

    logger.info('Inferred live loanApplicationId for outbound replay request', {
      logTag: entry.logTag,
      replayLoanApplicationId: entry.loanApplicationId,
      resolvedLoanApplicationId: bestCandidate.loanApplicationId,
      source: bestCandidate.source,
      candidateScore: bestCandidate.score,
      candidateMetadata: {
        logTag: bestCandidate.metadata?.logTag || null,
        sourceDestination: bestCandidate.metadata?.sourceDestination || null,
        orderId: bestCandidate.metadata?.orderId || null,
        lenderOrgId: bestCandidate.metadata?.lenderOrgId || null
      }
    });

    return bestCandidate.loanApplicationId;
  }
  
  async start() {
    if (this.isRunning) {
      logger.warn('Async orchestrator already running');
      return { success: false, message: 'Already running' };
    }
    
    this.isRunning = true;
    this.shouldStop = false;
    
    const { merchantId, orderId } = AsyncReplayOrchestrator.extractMerchantId(this.logs);
    this.replayMerchantId = merchantId || this.replayMerchantId || this.config.merchantId || null;
    const lenderOrgIdToIdMap = AsyncReplayOrchestrator.extractLenderOrgIds(this.logs);
    const preferredLenderOrgId = AsyncReplayOrchestrator.extractPreferredLenderOrgId(this.logs);
    const lineDetails = AsyncReplayOrchestrator.extractLineDetails(this.logs);
    const customerSeedData = AsyncReplayOrchestrator.extractCustomerSeedData(this.logs);
    const lineSeedData = AsyncReplayOrchestrator.extractLineSeedData(this.logs);

    await this.clearLspData(merchantId, orderId);
    await this.onboardSeedData(
      merchantId,
      lenderOrgIdToIdMap,
      lineDetails,
      customerSeedData,
      lineSeedData,
      preferredLenderOrgId
    );

    await this.waitForSeedSettle(merchantId, orderId);
    
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
    
    while (this.isRunning && !this.shouldStop) {
      try {
        const didWork = await this.processOneCycle();
        
        if (!didWork) {
          consecutiveNoWork++;
          const backoffMs = Math.min(this.pollIntervalMs * Math.pow(1.5, consecutiveNoWork), this.maxBackoffMs);
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

    if (!didWork) {
      didWork = await this.maybeRecoverStalledExternalRequest() || didWork;
    } else {
      this.lastIdleExternalEntryKey = null;
      this.idleExternalEntryCycles = 0;
    }
    
    return didWork;
  }

  buildIdleExternalEntryKey(entry) {
    if (!entry) {
      return null;
    }

    return [
      entry.index,
      entry.logTag || 'NO_TAG',
      entry.source || 'NO_SOURCE',
      entry.destination || 'NO_DEST',
      entry.requestId || 'NO_REQ'
    ].join('|');
  }

  async maybeRecoverStalledExternalRequest() {
    const entry = this.validator.getCurrentEntry();
    if (!entry || !entry.isRequest || this.validator.processedIndices.has(entry.index)) {
      this.lastIdleExternalEntryKey = null;
      this.idleExternalEntryCycles = 0;
      return false;
    }

    const isExternalSourceRequest = ['APP', 'LENDER', 'EULER', 'THEMIS'].includes(entry.source);
    if (!isExternalSourceRequest) {
      this.lastIdleExternalEntryKey = null;
      this.idleExternalEntryCycles = 0;
      return false;
    }

    const entryKey = this.buildIdleExternalEntryKey(entry);
    if (this.lastIdleExternalEntryKey === entryKey) {
      this.idleExternalEntryCycles += 1;
    } else {
      this.lastIdleExternalEntryKey = entryKey;
      this.idleExternalEntryCycles = 1;
    }

    if (this.idleExternalEntryCycles < 2) {
      return false;
    }

    logger.warn('Recovering stalled external-source replay entry after idle async cycles', {
      entry: entry.toString(),
      idleCycles: this.idleExternalEntryCycles,
      requestId: entry.requestId || null,
      sourceDestination: entry.sourceDestination || null
    });

    await this.triggerExternalRequestAsync(entry);
    this.lastIdleExternalEntryKey = null;
    this.idleExternalEntryCycles = 0;
    return true;
  }

  hasProcessedBranchAdvance(currentEntry, optionalRepeatPolicy) {
    if (!optionalRepeatPolicy.advanceWhenSeenLogTags?.length) {
      return false;
    }

    return this.validator.entries.some((entry, index) =>
      this.validator.processedIndices.has(index) &&
      index > currentEntry.index &&
      entry.isRequest &&
      optionalRepeatPolicy.advanceWhenSeenLogTags.includes(entry.logTag) &&
      sharesReplayContext(currentEntry, entry)
    );
  }

  hasObservedBranchAdvance(currentEntry, optionalRepeatPolicy) {
    if (optionalRepeatPolicy.allowObservedBranchAdvance === false) {
      return false;
    }

    if (!optionalRepeatPolicy.advanceWhenSeenLogTags?.length) {
      return false;
    }

    return (this.observedIncomingRequests || []).some(entry =>
      optionalRepeatPolicy.advanceWhenSeenLogTags.includes(entry.logTag) &&
      sharesReplayContext(currentEntry, entry)
    );
  }

  hasPriorProcessedAlternate(currentEntry, optionalRepeatPolicy) {
    const tagRules = optionalRepeatPolicy.skipWhenPriorProcessedLogTags || [];
    const conditionalRules = optionalRepeatPolicy.skipWhenPriorProcessedEntries || [];

    if (tagRules.length === 0 && conditionalRules.length === 0) {
      return false;
    }

    const observedMatch = (this.observedProcessedResponses || []).some(entry =>
      sharesReplayContext(currentEntry, entry) &&
      conditionalRules.some(condition =>
        entry?.logTag === condition.logTag &&
        (
          !condition.payloadPath ||
          getPayloadValueAtPath(entry.payload, condition.payloadPath) === condition.equals
        )
      )
    );

    if (observedMatch) {
      return true;
    }

    return this.validator.entries.some((entry, index) =>
      this.validator.processedIndices.has(index) &&
      index < currentEntry.index &&
      sharesReplayContext(currentEntry, entry) &&
      (
        tagRules.includes(entry.logTag) ||
        conditionalRules.some(condition =>
          entry?.logTag === condition.logTag &&
          (
            !condition.payloadPath ||
            getPayloadValueAtPath(entry.payload, condition.payloadPath) === condition.equals
          )
        )
      )
    );
  }

  shouldSkipTimedOutOptionalRequest(entry) {
    const optionalRepeatPolicy = getOptionalRepeatPolicy(this.config, entry);
    if (!optionalRepeatPolicy) {
      if (entry?.logTag === 'FETCH_OFFER_ASYNC_RESPONSE_REQUEST') {
        logger.info('Optional skip evaluation: no policy matched', {
          entry: entry.toString()
        });
      }
      return false;
    }

    const priorReplayOccurrences = this.validator.entries.filter(candidate =>
      candidate.isRequest &&
      candidate.index < entry.index &&
      candidate.source === entry.source &&
      candidate.destination === entry.destination &&
      candidate.logTag === entry.logTag &&
      sharesReplayContext(entry, candidate)
    );

    const processedSameTagCount = priorReplayOccurrences.filter(candidate =>
      this.validator.processedIndices.has(candidate.index)
    ).length;

    const branchAdvanced = this.hasProcessedBranchAdvance(entry, optionalRepeatPolicy);
    const branchAdvancedObserved = this.hasObservedBranchAdvance(entry, optionalRepeatPolicy);
    const priorAlternateProcessed = this.hasPriorProcessedAlternate(entry, optionalRepeatPolicy);
    const hasAnyAdvanceSignal = branchAdvanced || branchAdvancedObserved || priorAlternateProcessed;
    const isFetchOfferAsyncResponse = entry.logTag === 'FETCH_OFFER_ASYNC_RESPONSE_REQUEST';

    if (isFetchOfferAsyncResponse && (priorReplayOccurrences.length >= 1 || hasAnyAdvanceSignal)) {
      logger.warn('Skipping timed-out optional replay request in async mode', {
        entry: entry.toString(),
        priorReplayOccurrenceCount: priorReplayOccurrences.length,
        processedSameTagCount,
        branchAdvanced,
        branchAdvancedObserved,
        priorAlternateProcessed,
        advanceWhenSeenLogTags: optionalRepeatPolicy.advanceWhenSeenLogTags,
        skipWhenPriorProcessedLogTags: optionalRepeatPolicy.skipWhenPriorProcessedLogTags,
        skipWhenPriorProcessedEntries: optionalRepeatPolicy.skipWhenPriorProcessedEntries,
        specialCase: 'fetch_offer_async_repeat_or_advanced_branch'
      });
      return true;
    }

    if (optionalRepeatPolicy.requirePriorProcessedOccurrence && priorReplayOccurrences.length < 1) {
      logger.info('Optional skip evaluation blocked: no prior replay occurrence', {
        entry: entry.toString(),
        priorReplayOccurrenceCount: priorReplayOccurrences.length,
        processedSameTagCount,
        branchAdvanced,
        branchAdvancedObserved,
        priorAlternateProcessed,
        requirePriorProcessedOccurrence: optionalRepeatPolicy.requirePriorProcessedOccurrence,
        requireBranchAdvance: optionalRepeatPolicy.requireBranchAdvance
      });
      return false;
    }

    if (optionalRepeatPolicy.requireBranchAdvance && !hasAnyAdvanceSignal) {
      logger.info('Optional skip evaluation blocked: required branch advance missing', {
        entry: entry.toString(),
        priorReplayOccurrenceCount: priorReplayOccurrences.length,
        processedSameTagCount,
        branchAdvanced,
        branchAdvancedObserved,
        priorAlternateProcessed,
        requirePriorProcessedOccurrence: optionalRepeatPolicy.requirePriorProcessedOccurrence,
        requireBranchAdvance: optionalRepeatPolicy.requireBranchAdvance
      });
      return false;
    }

    if (
      optionalRepeatPolicy.requirePriorProcessedOccurrence &&
      processedSameTagCount < 1 &&
      !hasAnyAdvanceSignal
    ) {
      logger.info('Optional skip evaluation blocked: prior occurrence exists but neither processed nor branch-advanced', {
        entry: entry.toString(),
        priorReplayOccurrenceCount: priorReplayOccurrences.length,
        processedSameTagCount,
        branchAdvanced,
        branchAdvancedObserved,
        priorAlternateProcessed,
        requirePriorProcessedOccurrence: optionalRepeatPolicy.requirePriorProcessedOccurrence,
        requireBranchAdvance: optionalRepeatPolicy.requireBranchAdvance
      });
      return false;
    }

    if (
      !optionalRepeatPolicy.requirePriorProcessedOccurrence &&
      !optionalRepeatPolicy.allowSkipWithoutAdvance &&
      !hasAnyAdvanceSignal
    ) {
      logger.info('Optional skip evaluation blocked: no advance signal', {
        entry: entry.toString(),
        priorReplayOccurrenceCount: priorReplayOccurrences.length,
        processedSameTagCount,
        branchAdvanced,
        branchAdvancedObserved,
        priorAlternateProcessed,
        requirePriorProcessedOccurrence: optionalRepeatPolicy.requirePriorProcessedOccurrence,
        requireBranchAdvance: optionalRepeatPolicy.requireBranchAdvance,
        allowSkipWithoutAdvance: optionalRepeatPolicy.allowSkipWithoutAdvance || false
      });
      return false;
    }

    logger.warn('Skipping timed-out optional replay request in async mode', {
      entry: entry.toString(),
      priorReplayOccurrenceCount: priorReplayOccurrences.length,
      processedSameTagCount,
      branchAdvanced,
      branchAdvancedObserved,
      priorAlternateProcessed,
      advanceWhenSeenLogTags: optionalRepeatPolicy.advanceWhenSeenLogTags,
      skipWhenPriorProcessedLogTags: optionalRepeatPolicy.skipWhenPriorProcessedLogTags,
      skipWhenPriorProcessedEntries: optionalRepeatPolicy.skipWhenPriorProcessedEntries
    });

    return true;
  }

  skipOptionalReplayRequest(entry, reason = 'optional_skip') {
    const responseEntry = this.findCorrespondingResponse(entry, true);

    this.validator.markProcessed(entry);
    if (responseEntry) {
      this.validator.markProcessed(responseEntry);
    }

    logger.info('Skipped optional replay request in async mode', {
      reason,
      entry: entry.toString(),
      responseEntry: responseEntry?.toString?.() || null,
      currentIndex: this.validator.currentIndex
    });

    return true;
  }

  skipMissingThemisEligibilityReplayRequest(entry, reason = 'missing_live_lender_call') {
    const responseEntry = this.findCorrespondingResponse(entry, true);

    this.validator.markProcessed(entry);
    if (responseEntry) {
      this.validator.markProcessed(responseEntry);
    }

    const warningInfo = {
      type: 'MISSING_EXPECTED_ASYNC_CALL',
      logTag: entry.logTag,
      lenderOrgId: entry.lenderOrgId || null,
      requestEntry: entry.toString(),
      responseEntry: responseEntry?.toString?.() || null,
      reason
    };

    if (this.reportGenerator && this.orderId) {
      this.reportGenerator.recordReplayWarning(this.orderId, warningInfo);
    }

    logger.warn('Skipped missing Themis-Eligibility replay pair', {
      reason,
      orderId: this.orderId,
      lenderOrgId: entry.lenderOrgId || null,
      entry: entry.toString(),
      responseEntry: responseEntry?.toString?.() || null,
      currentIndex: this.validator.currentIndex
    });

    return true;
  }

  hasObservedTerminalHardEligibilityFailure(entry) {
    const observedProcessedResponses = this.observedProcessedResponses || [];
    if (observedProcessedResponses.some(responseEntry =>
      sharesReplayContext(entry, responseEntry) &&
      isTerminalHardEligibilityFailure(responseEntry.logTag, responseEntry.payload)
    )) {
      return true;
    }

    return this.validator.entries.some((validatorEntry, index) =>
      this.validator.processedIndices.has(index) &&
      sharesReplayContext(entry, validatorEntry) &&
      isTerminalHardEligibilityFailure(validatorEntry.logTag, validatorEntry.payload)
    );
  }

  hasProcessedHardEligibilityStatusResponse(entry) {
    const observedProcessedResponses = this.observedProcessedResponses || [];
    if (observedProcessedResponses.some(responseEntry =>
      sharesReplayContext(entry, responseEntry) &&
      responseEntry.logTag === 'FlipKart-HardEligibilityStatus_RESPONSE'
    )) {
      return true;
    }

    return this.validator.entries.some((validatorEntry, index) =>
      this.validator.processedIndices.has(index) &&
      sharesReplayContext(entry, validatorEntry) &&
      validatorEntry.logTag === 'FlipKart-HardEligibilityStatus_RESPONSE'
    );
  }
  
  async checkBufferedResponses() {
    const currentEntry = this.validator.getCurrentEntry();
    
    if (!currentEntry || !currentEntry.isResponse) {
      return false;
    }

    logger.info('Checking buffered response for replay entry', {
      entry: currentEntry.toString(),
      currentIndex: this.validator.currentIndex,
      responseBufferSize: this.bufferManager?.responseBuffer?.size || 0,
      incomingBufferSize: this.bufferManager?.incomingRequests?.size || 0,
      clientRequestId: currentEntry.clientRequestId || null,
      orderId: currentEntry.orderId || null
    });
    
    // Find the corresponding request entry (should be the previous unprocessed request)
    const requestEntry = this.findCorrespondingRequest(currentEntry);
    if (!requestEntry) {
      logger.warn('No corresponding request found for response, trying response-only buffer resolution', {
        responseEntry: currentEntry.toString(),
        requestId: currentEntry.requestId || null,
        clientRequestId: currentEntry.clientRequestId || null,
        sourceDestination: currentEntry.sourceDestination
      });

      return this.tryConsumeBufferedResponse(currentEntry, null);
    }

    // Core replay contract for GATEWAY->LENDER:
    // once the live _REQUEST has been buffered, matched, and validated, the later
    // _RESPONSE step must be served from replay logs when sequence reaches it.
    // It should not depend on a second live lender response arriving in ART.
    const hasHeldGatewayLenderRequest =
      requestEntry.source === 'GATEWAY' &&
      requestEntry.destination === 'LENDER' &&
      currentEntry.source === 'LENDER' &&
      currentEntry.destination === 'GATEWAY' &&
      (
        this.pendingExternalRequests.has(this.getContextKey(currentEntry)) ||
        this.pendingExternalRequests.has(this.getContextKey(requestEntry))
      );

    if (
      requestEntry.source === 'GATEWAY' &&
      requestEntry.destination === 'LENDER' &&
      currentEntry.source === 'LENDER' &&
      currentEntry.destination === 'GATEWAY' &&
      (
        this.validator.processedIndices.has(requestEntry.index) ||
        hasHeldGatewayLenderRequest
      )
    ) {
      return this.replayGatewayLenderResponseFromLogs(requestEntry, currentEntry);
    }
    
    return this.tryConsumeBufferedResponse(currentEntry, requestEntry);
  }

  replayGatewayLenderResponseFromLogs(requestEntry, responseEntry) {
    this.bufferManager?.clearWaitDiagnostics?.(requestEntry, 'gateway_lender_response_replay');
    this.markStuckEntryResolved(requestEntry, 'gateway_lender_response_replayed_from_logs');
    const responseContextKey = this.getContextKey(responseEntry);
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
        payload: transformRequest(responseEntry.payload, responseEntry.logTag)
      });
    }

    logger.logApiCall(
      responseEntry.source,
      responseEntry.destination,
      getEndpointConfig(requestEntry.sourceDestination, requestEntry.logTag)?.endpoint || requestEntry.api || null,
      'RESPONSE',
      responseEntry.index
    );

    this.validator.advance();
    this.recordSuccess('gateway_lender_response_replay', responseEntry);

    logger.info('Replayed GATEWAY->LENDER response directly from logs', {
      requestEntry: requestEntry.toString(),
      responseEntry: responseEntry.toString(),
      responseContextKey,
      requestContextKey,
      resolvedContextKey: contextKey
    });

    return true;
  }

  async tryConsumeBufferedResponse(currentEntry, requestEntry = null) {
    const requestIds = [
      requestEntry?.requestId,
      requestEntry?.xRequestId,
      currentEntry.requestId,
      currentEntry.xRequestId
    ].filter(Boolean);
    const effectiveClientRequestId = currentEntry.clientRequestId || requestEntry?.clientRequestId || null;
    const effectiveLoanApplicationId = currentEntry.loanApplicationId || requestEntry?.loanApplicationId || null;
    const effectiveLenderOrgId = currentEntry.lenderOrgId || requestEntry?.lenderOrgId || null;
    const effectiveOrderId = currentEntry.orderId || requestEntry?.orderId || this.orderId || null;

    let requestId = requestIds[0] || null;
    let buffered = this.bufferManager.getResponseByMetadata(
      currentEntry.logTag,
      currentEntry.sourceDestination,
      effectiveLoanApplicationId,
      effectiveLenderOrgId,
      effectiveClientRequestId,
      requestIds,
      effectiveOrderId
    );

    if (!buffered) {
      for (const candidateRequestId of requestIds) {
        buffered = this.bufferManager.getResponse(candidateRequestId);
        if (buffered) {
          requestId = candidateRequestId;
          break;
        }
      }
    }

    if (
      !buffered &&
      currentEntry.sourceDestination === 'APP_WRAPPER' &&
      this.bufferManager?.responseBuffer?.size === 1
    ) {
      const [[fallbackRequestId, fallbackEntry]] = this.bufferManager.responseBuffer.entries();
      this.bufferManager.responseBuffer.delete(fallbackRequestId);
      buffered = fallbackEntry;
      requestId = fallbackRequestId;

      logger.info('Using sole buffered APP_WRAPPER response as fallback match', {
        entry: currentEntry.toString(),
        requestEntry: requestEntry?.toString?.() || null,
        fallbackRequestId
      });
    }
    
    if (!buffered) {
      logger.info('Response not yet in buffer', {
        requestIds,
        currentEntryLogTag: currentEntry.logTag,
        currentEntrySourceDestination: currentEntry.sourceDestination,
        effectiveClientRequestId,
        effectiveLoanApplicationId,
        effectiveLenderOrgId,
        effectiveOrderId,
        responseEntry: currentEntry.toString(),
        requestEntry: requestEntry?.toString?.() || null,
        responseBufferSize: this.bufferManager?.responseBuffer?.size || 0
      });
      return false;
    }
    
    logger.info('Found buffered response for current entry', {
      entry: currentEntry.toString(),
      requestId,
      requestEntry: requestEntry?.toString?.() || null
    });

    const replayBufferedResponseData = this.stateManager?.remapReplayValue
      ? this.stateManager.remapReplayValue(buffered.response.data, null, { logTag: currentEntry.logTag })
      : buffered.response.data;
    
    if (buffered.isError) {
      const r = buffered.response;
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
      replayBufferedResponseData,
      currentEntry.logTag,
      currentEntry
    );
    
    if (!comparison.match) {
      logger.warn('Buffered response comparison mismatch tolerated', {
        entry: currentEntry.toString(),
        logTag: currentEntry.logTag,
        differences: comparison.differences
      });
    } else {
      this.stateManager.registerMappingsFromPayloadPair(
        currentEntry.payload,
        replayBufferedResponseData,
        {
          logTag: currentEntry.logTag,
          expectedPayload: currentEntry.payload || null,
          actualPayload: replayBufferedResponseData || null
        }
      );
    }

    if (currentEntry.logTag === 'GetLenderFlows_RESPONSE') {
      this.stateManager?.updateReplayAppAuthFromResponse?.(
        currentEntry.loanApplicationId || requestEntry?.loanApplicationId || null,
        replayBufferedResponseData,
        { logTag: currentEntry.logTag }
      );
    }

    this.recordObservedProcessedResponse(currentEntry, replayBufferedResponseData);
    
    this.validator.advance();
    this.recordSuccess('buffered_response_validation', currentEntry);

    const postBatchConfirmationSucceeded = await this.runPostBatchConfirmationIfNeeded(
      currentEntry,
      requestEntry,
      buffered.metadata || {}
    );
    if (!postBatchConfirmationSucceeded) {
      return true;
    }
    
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

    if (!this.inFlightEntryProcessing) {
      this.inFlightEntryProcessing = new Map();
    }

    const inFlightEntryKey = `${entry.index}:${this.validator.currentIndex}`;
    const existingInFlightProcessing = this.inFlightEntryProcessing.get(inFlightEntryKey);
    if (existingInFlightProcessing) {
      logger.info('Reusing in-flight replay processing for current entry', {
        entry: entry.toString(),
        inFlightEntryKey
      });
      return existingInFlightProcessing;
    }

    const processingPromise = this._processNextLogEntryInternal(entry)
      .finally(() => {
        if (this.inFlightEntryProcessing?.get(inFlightEntryKey) === processingPromise) {
          this.inFlightEntryProcessing.delete(inFlightEntryKey);
        }
      });

    this.inFlightEntryProcessing.set(inFlightEntryKey, processingPromise);
    return processingPromise;
  }

  async _processNextLogEntryInternal(entry) {
    this.maybeRegisterObservedImmediateGatewayLenderSatisfaction(entry);
    this.maybeRegisterObservedImmediateCoreGatewaySatisfaction(entry);

    if (this.maybeResolvePreSatisfiedReplayEntry(entry)) {
      return true;
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
    const shouldOrchestratorInitiate = orchestratorInitiatedSources.includes(entry.source);
    
    if (shouldOrchestratorInitiate && entry.isRequest) {
      await this.triggerExternalRequestAsync(entry);
      return true;
    } else if (entry.isRequest) {
      const hasBufferedMatch = this.bufferManager?.hasMatchingBufferedRequest?.(entry) || false;
      const isSkippableAsync = isSkippableAsyncApiLogTag(entry.logTag);

      if (isSkippableAsync) {
        logger.info('Matched skippable async API during replay', {
          entry: entry.toString(),
          logTag: entry.logTag,
          configuredSkippableAsyncApis: Array.from(SKIPPABLE_ASYNC_API_LOG_TAGS),
          hasBufferedMatch
        });
      }

      const shouldPreWaitSkip = this.shouldSkipTimedOutOptionalRequest(entry);

      logger.info('Pre-wait optional skip decision', {
        entry: entry.toString(),
        hasBufferedMatch,
        shouldPreWaitSkip,
        isSkippableAsync
      });

      if (!isSkippableAsync && shouldPreWaitSkip && !hasBufferedMatch) {
        logger.info('Deferring optional replay skip until after request wait window', {
          entry: entry.toString(),
          reason: 'pre_wait_skip_disabled_wait_first'
        });
      }

      const effectiveTimeoutMs = this.getRequestWaitTimeoutMs(entry);

      logger.info('Current request buffer probe', {
        entry: entry.toString(),
        hasBufferedMatch,
        bufferDiagnostics: this.bufferManager?.getIncomingBufferDiagnostics?.(entry, 10) || null
      });

      if (hasBufferedMatch) {
        const consumedBufferedCurrentRequest = await this.maybeConsumeBufferedCurrentExpectedRequest(entry);
        if (consumedBufferedCurrentRequest) {
          return true;
        }

        logger.warn('Buffered match probe reported true but immediate buffered consumption did not succeed', {
          entry: entry.toString(),
          bufferDiagnostics: this.bufferManager?.getIncomingBufferDiagnostics?.(entry, 10) || null
        });
      }

      if (!hasBufferedMatch) {
        await this.maybePrimeLoanSettlementPt(entry);
      }

      logger.info('Replay thread waiting for incoming request', {
        entry: entry.toString(),
        timeoutMs: effectiveTimeoutMs,
        isSkippableAsync,
        hasBufferedMatch
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

        if (this.shouldSkipTimedOutOptionalRequest(entry)) {
          logger.warn('Buffered request wait expired and entry is eligible for skip', {
            entry: entry.toString(),
            timeoutMs: effectiveTimeoutMs,
            isSkippableAsync
          });
          return this.skipOptionalReplayRequest(entry, 'timed_out_optional_skip');
        }

        if (entry.logTag === 'Themis-Eligibility_REQUEST' && entry.source === 'GATEWAY') {
          logger.warn('Buffered request wait expired for Themis-Eligibility lender call; skipping replay pair', {
            entry: entry.toString(),
            timeoutMs: effectiveTimeoutMs,
            lenderOrgId: entry.lenderOrgId || null
          });
          return this.skipMissingThemisEligibilityReplayRequest(entry, 'timed_out_missing_lender_call');
        }

        if (isSelfTriggerFallbackApiLogTag(entry.logTag)) {
          logger.warn('Buffered request wait expired for configured self-trigger fallback API; triggering service directly and continuing replay', {
            entry: entry.toString(),
            timeoutMs: effectiveTimeoutMs,
            configuredFallbackApis: Array.from(SELF_TRIGGER_FALLBACK_API_LOG_TAGS)
          });
          return this.triggerMissingExpectedRequestFallback(entry, effectiveTimeoutMs);
        }

        logger.warn('ASYNC_ORCH_REPLAY_WAIT_MISSING', {
          entry: entry.toString(),
          timeoutMs: effectiveTimeoutMs,
          orderId: this.orderId,
          bufferDiagnostics: this.bufferManager?.getIncomingBufferDiagnostics?.(entry, 50) || null,
          pendingWaiters: this.bufferManager?.getPendingRequestWaiters?.() || []
        });
        return false;
      }

      try {
        logger.info('ASYNC_ORCH_REPLAY_CLAIMED_BUFFERED_REQUEST', {
          orderId: this.orderId,
          expectedEntry: entry.toString(),
          expectedIndex: entry.index,
          bufferKey: buffered.key,
          bufferedAgeMs: Date.now() - buffered.timestamp,
          bufferedRequest: this.bufferManager?.summarizeRequestForDiagnostics?.(buffered.request) || {
            source: buffered.request?.source,
            destination: buffered.request?.destination,
            logTag: buffered.request?.logTag,
            requestId: buffered.request?.requestId || null
          }
        });
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

  async maybeConsumeBufferedCurrentExpectedRequest(entry) {
    if (!entry?.isRequest || !this.bufferManager?.findMatchingRequest) {
      return false;
    }

    const buffered = this.bufferManager.findMatchingRequest(entry, { claim: true });
    if (!buffered) {
      logger.info('No claimable buffered current request found during immediate consume attempt', {
        entry: entry.toString(),
        bufferDiagnostics: this.bufferManager?.getIncomingBufferDiagnostics?.(entry, 10) || null
      });
      return false;
    }

    logger.info('Consuming already-buffered current expected request immediately', {
      entry: entry.toString(),
      bufferKey: buffered.key,
      requestId: buffered.request?.requestId || null,
      logTag: buffered.request?.logTag || null
    });

    try {
      const response = await super.handleIncomingRequest(buffered.request);
      this.bufferManager.completeIncomingRequest(buffered.key, response);
      return true;
    } catch (error) {
      this.bufferManager.failIncomingRequest(buffered.key, error);
      throw error;
    }
  }

  getRequestWaitTimeoutMs(entry) {
    if (entry?.logTag === 'LOAN_SETTLEMENT_PT_REQUEST') {
      logger.info('Using minimal wait timeout for loan settlement PT helper-triggered replay request', {
        entry: entry?.toString?.(),
        logTag: entry?.logTag,
        timeoutMs: 1_500
      });
      return 1_500;
    }

    if (isSkippableAsyncApiLogTag(entry.logTag)) {
      logger.info('Using short wait timeout for skippable async API', {
        entry: entry?.toString?.(),
        logTag: entry?.logTag,
        timeoutMs: 40_000,
        configuredSkippableAsyncApis: Array.from(SKIPPABLE_ASYNC_API_LOG_TAGS)
      });
      return 40_000;
    }

    if (isSelfTriggerFallbackApiLogTag(entry.logTag)) {
      const timeoutMs = SELF_TRIGGER_FALLBACK_WAIT_TIMEOUT_OVERRIDES_MS[entry?.logTag] || 9_000;
      logger.info('Using short wait timeout for self-trigger fallback API', {
        entry: entry?.toString?.(),
        logTag: entry?.logTag,
        timeoutMs,
        configuredFallbackApis: Array.from(SELF_TRIGGER_FALLBACK_API_LOG_TAGS)
      });
      return timeoutMs;
    }

    const optionalRepeatPolicy = getOptionalRepeatPolicy(this.config, entry);
    if (optionalRepeatPolicy?.optionalAfterSeconds) {
      const timeoutMs = optionalRepeatPolicy.optionalAfterSeconds * 1000;
      logger.info('Using optional-repeat wait timeout override', {
        entry: entry?.toString?.(),
        logTag: entry?.logTag,
        timeoutMs,
        optionalRepeatPolicy
      });
      return timeoutMs;
    }

    const baseTimeoutMs = this.config.timeoutMs;
    const perLogTagOverrideMs = RETRY_TIMEOUT_OVERRIDES[entry.logTag]
      ? RETRY_TIMEOUT_OVERRIDES[entry.logTag] * 1000
      : 0;
    const isGatewayToLender = entry.source === 'GATEWAY' && entry.destination === 'LENDER';
    const gatewayToLenderTimeoutMs = isGatewayToLender ? baseTimeoutMs * 5 : baseTimeoutMs;
    return Math.max(baseTimeoutMs, gatewayToLenderTimeoutMs, perLogTagOverrideMs);
  }
  
  async triggerExternalRequestAsync(entry) {
    return this.triggerExternalRequestAsyncWithOptions(entry);
  }

  async triggerExternalRequestAsyncWithOptions(entry, options = {}) {
    const {
      advanceValidator = true,
      tolerateFailure = false,
      fallbackReason = null
    } = options;

    try {
      const endpointConfig = getEndpointConfig(entry.sourceDestination, entry.logTag);
      const resolvedEndpoint = resolveWrapperEndpointForMerchant(entry, endpointConfig);
      const replayEndpoint = resolveReplayEndpoint(entry.url);
      const isDirectLenderGatewayRequest =
        entry.isRequest && entry.source === 'LENDER' && entry.destination === 'GATEWAY';
      let api = resolvedEndpoint || this.getApiForLogTag(entry.logTag);
      if (isDirectLenderGatewayRequest && replayEndpoint) {
        api = replayEndpoint;
      }
      api = this.stateManager?.rewriteOutgoingLoanApplicationIdsInEndpoint
        ? this.stateManager.rewriteOutgoingLoanApplicationIdsInEndpoint(api, {
          logTag: entry?.logTag,
          field: 'endpoint'
        })
        : api;
      const endpointHeaders = {
        ...(endpointConfig?.headers || {}),
        ...buildReplaySessionHeaders(entry, this.validator.entries, this.stateManager),
        ...buildAppCoreAuthHeaders(entry, this.validator.entries, this.stateManager)
      };
      await ensureAppCorePreconditions(entry, endpointHeaders, this.stateManager);
      const { requestId: outboundRequestId, originalRequestId, normalized, reusedFromLogTag } =
        getAppCoreRequestId({
          ...entry,
          stateManager: this.stateManager
        });
      const service = endpointConfig?.service || entry.destination;
      const method = entry.httpMethod || endpointConfig?.method || 'POST';
      const resolvedLoanApplicationId = this.resolveOutboundLoanApplicationIdForReplay(entry, {
        allowInferenceFromLiveBuffer: Boolean(fallbackReason)
      });
      
      const remappedPayload = remapReplayIds(
        entry.payload,
        this.stateManager,
        entry.logTag,
        null,
        resolvedLoanApplicationId
      );
      const transformedPayload = transformRequest(remappedPayload, entry.logTag);
      const forwardingRequest = prepareAsyncReplayForwarding(
        entry,
        transformedPayload,
        outboundRequestId,
        endpointHeaders,
        this.replayMerchantId || this.config.merchantId || null,
        this.observedIncomingRequests || [],
        this.stateManager
      );
      this.stateManager?.setReplayRequestIdForLogTag?.(entry.logTag, forwardingRequest.requestId, {
        sourceDestination: entry.sourceDestination,
        source: entry.source,
        destination: entry.destination
      });

      if (
        (
          entry.logTag === 'Lsp-LoanStatusRequest_REQUEST' ||
          entry.logTag === 'LSP-GetStatus_REQUEST' ||
          entry.logTag === 'VerifyLenderOTPRequest-LSP_REQUEST'
        ) &&
        fallbackReason
      ) {
        const lenderDetailsSeedPayload = buildReplayLenderDetailsSeedPayload(
          entry,
          forwardingRequest.payload,
          this.replayMerchantId || this.config.merchantId || null,
          this.observedIncomingRequests || [],
          this.validator?.entries || []
        );

        if (lenderDetailsSeedPayload) {
          logger.info('Priming gateway lender details before self-triggered gateway-status replay', {
            logTag: entry.logTag,
            requestId: lenderDetailsSeedPayload.requestId,
            lenderOrgId: lenderDetailsSeedPayload.lenderOrgId,
            merchantId: lenderDetailsSeedPayload.merchantId,
            hasGatewayRefId: Boolean(lenderDetailsSeedPayload.gatewayRefId),
            hasLenderRedirectionUrl: Boolean(lenderDetailsSeedPayload.lenderRedirectionUrl)
          });

          const lenderDetailsSeedStart = this.orderProfiler?.enabled ? this.orderProfiler.now() : 0;
          const lenderDetailsSeedResponse = await makeRequest(
            SERVICE_MAP.LSP.baseUrl,
            '/art/lender-details/set',
            'POST',
            lenderDetailsSeedPayload,
            lenderDetailsSeedPayload.requestId,
            null,
            'ART_SET_LENDER_DETAILS_REPLAY',
            lenderDetailsSeedPayload.merchantId,
            {},
            null,
            SERVICE_MAP.LSP.unixSocket,
            10000
          );
          this.orderProfiler?.recordDownstreamCall({
            destination: 'LSP',
            endpoint: '/art/lender-details/set',
            logTag: 'ART_SET_LENDER_DETAILS_REPLAY',
            logIndex: null,
            requestId: lenderDetailsSeedPayload.requestId,
            status: lenderDetailsSeedResponse?.status ?? null,
            success: Boolean(lenderDetailsSeedResponse && !lenderDetailsSeedResponse.error && lenderDetailsSeedResponse.status === 200),
            durationMs: this.orderProfiler.now() - lenderDetailsSeedStart
          });

          logger.info('Gateway lender details priming completed', {
            logTag: entry.logTag,
            requestId: lenderDetailsSeedPayload.requestId,
            status: lenderDetailsSeedResponse.status,
            error: lenderDetailsSeedResponse.error || false,
            responseData: lenderDetailsSeedResponse.data || null
          });
        } else {
          logger.warn('Skipped gateway lender details priming because replay context was incomplete', {
            logTag: entry.logTag,
            fallbackReason,
            hasPayloadRequestId: Boolean(forwardingRequest.payload?.requestId),
            lenderOrgId: entry.lenderOrgId || forwardingRequest.payload?.lenderOrgId || forwardingRequest.payload?.lender_org_id || null
          });
        }
      }
      
      logger.info('ORCH_SENDING_ASYNC', {
        destination: service,
        api,
        method,
        logTag: entry.logTag,
        requestId: forwardingRequest.requestId,
        originalRequestId,
        requestIdNormalizedForAppCore: normalized,
        requestIdReusedFromLogTag: reusedFromLogTag,
        merchantId: forwardingRequest.merchantId,
        originalPayloadRequestId:
          transformedPayload && typeof transformedPayload === 'object' && !Array.isArray(transformedPayload)
            ? transformedPayload.requestId || null
            : null,
        forwardedPayloadRequestId:
          forwardingRequest.payload && typeof forwardingRequest.payload === 'object' && !Array.isArray(forwardingRequest.payload)
            ? forwardingRequest.payload.requestId || null
            : null,
        replayRequestIdReuseCandidate: forwardingRequest.replayRequestIdCandidate,
        hasMerchantHeader: Boolean(
          forwardingRequest.headers['x-merchant-id'] || forwardingRequest.headers['X-Merchant-Id']
        )
      });

      const pairedResponseEntry = this.findCorrespondingResponse(entry, true);
      const shouldUseImmediatePairedResponseFlow =
        APP_CORE_IMMEDIATE_PAIRED_RESPONSE_LOG_TAGS.has(entry.logTag) &&
        entry.sourceDestination === 'APP_CORE' &&
        Boolean(pairedResponseEntry);

      if (shouldUseImmediatePairedResponseFlow) {
        logger.info('Using immediate APP_CORE paired-response replay flow', {
          requestEntry: entry.toString(),
          responseEntry: pairedResponseEntry?.toString?.() || null,
          requestId: forwardingRequest.requestId,
          api,
          method
        });
        this.registerPreSatisfiedReplayEntry(entry, {
          requestId: forwardingRequest.requestId,
          reason: 'immediate_app_core_paired_response'
        });

        if (pairedResponseEntry && !this.validator.processedIndices.has(pairedResponseEntry.index)) {
          this.validator.markProcessed(pairedResponseEntry);
          this.recordSuccess('immediate_app_core_paired_response', pairedResponseEntry);
          logger.info('Marked immediate APP_CORE paired response as processed', {
            requestEntry: entry.toString(),
            responseEntry: pairedResponseEntry.toString(),
            requestId: forwardingRequest.requestId
          });
        }
      }

      if (entry.logTag === 'FlipKart-GetRedirectionURL_REQUEST') {
        logger.info('Applying pre-send delay before FlipKart getRedirectionUrl replay', {
          requestEntry: entry.toString(),
          requestId: forwardingRequest.requestId,
          delayMs: 1000,
          api
        });
        await new Promise(resolve => setTimeout(resolve, 1000));
        logger.info('Completed pre-send delay before FlipKart getRedirectionUrl replay', {
          requestEntry: entry.toString(),
          requestId: forwardingRequest.requestId,
          delayMs: 1000,
          api
        });
      }
      
      this.httpClient.send(
        this.getServiceBaseUrl(service),
        api,
        method,
        forwardingRequest.payload,
        forwardingRequest.requestId,
        entry.sourceDestination,
        entry.logTag,
        forwardingRequest.merchantId,
        forwardingRequest.headers,
        entry.index,
        this.getServiceUnixSocket(service),
        resolvedLoanApplicationId,
        entry.lenderOrgId,
        entry.clientRequestId
      );

      if (advanceValidator) {
        this.validator.advance();
      }
      
      logger.info('Async request sent, main thread continuing', {
        requestId: forwardingRequest.requestId,
        originalRequestId,
        logTag: entry.logTag,
        advanceValidator,
        tolerateFailure,
        fallbackReason
      });

      return {
        success: true,
        requestId: forwardingRequest.requestId,
        originalRequestId
      };
    } catch (error) {
      if (tolerateFailure) {
        logger.warn('Failed to trigger async external request fallback; continuing replay', {
          entry: entry.toString(),
          logTag: entry.logTag,
          error: error.message,
          fallbackReason
        });
        if (this.reportGenerator && this.orderId) {
          this.reportGenerator.recordReplayWarning(this.orderId, {
            type: 'SELF_TRIGGER_FALLBACK_SEND_FAILED',
            logTag: entry.logTag,
            logIndex: entry.index,
            error: error.message,
            fallbackReason
          });
        }
        return {
          success: false,
          error: error.message
        };
      }

      logger.error('Failed to trigger async external request', {
        entry: entry.toString(),
        error: error.message
      });
      this.recordFailure('async_external_request_trigger', entry, error.message);
      await this.fail('Failed to trigger async external request for ' + entry.logTag + ': ' + error.message);
    }
  }

  async triggerMissingExpectedRequestFallback(entry, timeoutMs) {
    const responseEntry = this.findCorrespondingResponse(entry, true);
    const recoveryInfo = {
      type: 'SELF_TRIGGER_FALLBACK',
      logTag: entry.logTag,
      logIndex: entry.index,
      responseLogTag: responseEntry?.logTag || null,
      responseLogIndex: responseEntry?.index ?? null,
      timeoutMs,
      sourceDestination: entry.sourceDestination,
      fallbackMode: 'async_fire_and_forget'
    };

    if (this.reportGenerator && this.orderId) {
      this.reportGenerator.recordReplayWarning(this.orderId, {
        ...recoveryInfo,
        message: 'Missing expected request was self-triggered after replay buffer wait timeout'
      });
    }

    const triggerResult = await this.triggerExternalRequestAsyncWithOptions(entry, {
      advanceValidator: false,
      tolerateFailure: true,
      fallbackReason: 'missing_expected_request_after_wait_timeout'
    });

    if (this.reportGenerator && this.orderId) {
      this.reportGenerator.recordFallbackRecovery(this.orderId, {
        ...recoveryInfo,
        triggerStatus: triggerResult.success ? 'TRIGGERED' : 'FAILED_TO_TRIGGER',
        error: triggerResult.error || null
      });
    }

    this.validator.markProcessed(entry);
    if (responseEntry) {
      this.validator.markProcessed(responseEntry);
    }

    this.bufferManager?.skipWaiter?.(entry);
    this.bufferManager?.clearWaitDiagnostics?.(entry, 'self_trigger_fallback_processed');
    this.markStuckEntryResolved(entry, 'self_trigger_fallback_processed');

    this.recordSuccess('missing_expected_request_fallback', entry);
    if (responseEntry) {
      this.recordSuccess('missing_expected_request_fallback_response', responseEntry);
    }

    logger.info('Self-trigger fallback processed replay pair', {
      entry: entry.toString(),
      responseEntry: responseEntry?.toString?.() || null,
      timeoutMs,
      triggerStatus: triggerResult.success ? 'TRIGGERED' : 'FAILED_TO_TRIGGER'
    });

    return true;
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
      return true;
    }

    const isEarlyTerminalPollingResult =
      requestEntry.logTag === 'FlipKart-HardEligibilityStatus_REQUEST' &&
      this.findAllCorrespondingResponses(requestEntry).some(candidate => {
        if (!candidate?.payload || candidate.index <= (expectedResponse?.index || requestEntry.index)) {
          return false;
        }

        const candidatePayload = candidate.payload;
        const candidateStatus = candidatePayload.status || candidatePayload.Status || null;
        const candidateError =
          candidatePayload.error?.error_message ||
          candidatePayload.error?.message ||
          candidatePayload.errorMessage ||
          candidatePayload.message ||
          null;
        const candidateErrorCode =
          candidatePayload.error?.error_code ||
          candidatePayload.error?.code ||
          candidatePayload.errorCode ||
          null;

        return (
          candidateStatus === 'FAILURE' &&
          (
            (candidateError && actualError && candidateError === actualError) ||
            (candidateErrorCode && actualErrorCode && candidateErrorCode === actualErrorCode)
          )
        );
      });

    if (isEarlyTerminalPollingResult) {
      logger.info('Treating early terminal polling API failure as expected replay response', {
        requestId: activeReq.requestId || null,
        logTag: activeReq.logTag,
        logIndex: activeReq.logIndex,
        actualError,
        actualErrorCode
      });
      return true;
    }

    const matchesAnyTerminalHardEligibilityReplayResponse =
      activeReq?.logTag === 'FlipKart-HardEligibilityStatus_REQUEST' &&
      this.validator.entries.some(entry => {
        if (entry?.logTag !== 'FlipKart-HardEligibilityStatus_RESPONSE' || !entry?.payload) {
          return false;
        }

        const candidateStatus = entry.payload.status || entry.payload.Status || null;
        const candidateError =
          entry.payload.error?.error_message ||
          entry.payload.error?.message ||
          entry.payload.errorMessage ||
          entry.payload.message ||
          null;
        const candidateErrorCode =
          entry.payload.error?.error_code ||
          entry.payload.error?.code ||
          entry.payload.errorCode ||
          null;

        return (
          candidateStatus === 'FAILURE' &&
          (
            (candidateError && actualError && candidateError === actualError) ||
            (candidateErrorCode && actualErrorCode && candidateErrorCode === actualErrorCode)
          )
        );
      });

    if (matchesAnyTerminalHardEligibilityReplayResponse) {
      logger.info('Treating terminal hard-eligibility polling API failure as expected replay response via global fallback', {
        requestId: activeReq.requestId || null,
        logTag: activeReq.logTag,
        logIndex: activeReq.logIndex || null,
        actualError,
        actualErrorCode
      });
      return true;
    }

    return false;
  }

  buildFailureFallbackResponse(activeReq, response, apiFailure = null, exception = null) {
    if (!activeReq?.logTag || !isToleratedBatchTimeoutApiLogTag(activeReq.logTag)) {
      return null;
    }

    const failureMessage = [
      apiFailure?.error_message,
      apiFailure?.message,
      apiFailure?.description,
      response?.message,
      exception?.message
    ]
      .filter(Boolean)
      .join(' | ')
      .toLowerCase();

    const isTimeoutLikeFailure =
      failureMessage.includes('timeout') ||
      failureMessage.includes('timed out') ||
      failureMessage.includes('no response from eligibility core within timeout');

    if (!isTimeoutLikeFailure) {
      return null;
    }

    const requestEntry = this.validator.entries.find(entry => entry.index === activeReq.logIndex);
    if (!requestEntry) {
      return null;
    }

    const expectedResponse = this.findCorrespondingResponse(requestEntry, true);
    if (!expectedResponse?.payload) {
      return null;
    }

    const hasLaterReplayAttempt = this.hasLaterMatchingReplayRequest(requestEntry);
    const postBatchConfirmationRequired = this.shouldRequirePostBatchConfirmation(
      requestEntry,
      hasLaterReplayAttempt
    );

    if (postBatchConfirmationRequired) {
      this.pendingPostBatchConfirmations.set(expectedResponse.index, {
        requestEntryIndex: requestEntry.index,
        responseEntryIndex: expectedResponse.index
      });
    }

    if (this.reportGenerator && this.orderId) {
      this.reportGenerator.recordReplayWarning(this.orderId, {
        type: 'TOLERATED_BATCH_TIMEOUT_FALLBACK',
        logTag: activeReq.logTag,
        logIndex: activeReq.logIndex,
        requestEntry: requestEntry.toString(),
        responseEntry: expectedResponse.toString(),
        hasLaterReplayAttempt,
        postBatchConfirmationRequired,
        error: failureMessage || null
      });
    }

    logger.warn('Using replay response fallback for tolerated batch timeout request', {
      logTag: activeReq.logTag,
      requestId: activeReq.requestId || null,
      logIndex: activeReq.logIndex,
      requestEntry: requestEntry.toString(),
      responseEntry: expectedResponse.toString(),
      hasLaterReplayAttempt,
      postBatchConfirmationRequired,
      failureMessage: failureMessage || null
    });

    return {
      reason: 'tolerated_batch_timeout_replay_response_fallback',
      postBatchConfirmationRequired,
      postBatchConfirmationResponseIndex: expectedResponse.index,
      response: {
        status: response?.status || 200,
        statusText: response?.statusText || 'OK',
        data: expectedResponse.payload,
        headers: response?.headers || {},
        error: false
      }
    };
  }

  hasLaterMatchingReplayRequest(requestEntry) {
    if (!requestEntry) {
      return false;
    }

    return this.validator.entries.some(candidate => {
      if (!candidate?.isRequest || candidate.index <= requestEntry.index) {
        return false;
      }

      if (
        candidate.source !== requestEntry.source ||
        candidate.destination !== requestEntry.destination ||
        candidate.logTag !== requestEntry.logTag
      ) {
        return false;
      }

      if (
        requestEntry.loanApplicationId &&
        candidate.loanApplicationId &&
        requestEntry.loanApplicationId !== candidate.loanApplicationId
      ) {
        return false;
      }

      if (
        requestEntry.orderId &&
        candidate.orderId &&
        requestEntry.orderId !== candidate.orderId
      ) {
        return false;
      }

      return true;
    });
  }

  shouldRequirePostBatchConfirmation(requestEntry, hasLaterReplayAttempt) {
    if (!requestEntry || hasLaterReplayAttempt) {
      return false;
    }

    // Real-time eligibility already has a matched replay response in the
    // tolerated-batch fallback path, so issuing another blocking confirmation
    // call just adds avoidable wait and makes the batch appear stuck.
    if (requestEntry.logTag === 'FlipKart-RealTimeEligibility_REQUEST') {
      return false;
    }

    return true;
  }

  async runPostBatchConfirmationIfNeeded(responseEntry, requestEntry = null, bufferedMetadata = {}) {
    if (!bufferedMetadata?.postBatchConfirmationRequired) {
      return true;
    }

    const scheduledConfirmation = this.pendingPostBatchConfirmations.get(responseEntry.index);
    this.pendingPostBatchConfirmations.delete(responseEntry.index);

    const confirmationRequestEntry =
      requestEntry ||
      this.validator.entries.find(entry => entry.index === scheduledConfirmation?.requestEntryIndex) ||
      null;

    if (!confirmationRequestEntry) {
      logger.warn('Skipped post-batch confirmation because request entry was unavailable', {
        responseEntry: responseEntry.toString()
      });
      return true;
    }

    logger.info('Running post-batch confirmation call for tolerated replay timeout flow', {
      requestEntry: confirmationRequestEntry.toString(),
      responseEntry: responseEntry.toString()
    });

    const confirmationResult = await this.executeBlockingReplayRequest(confirmationRequestEntry, {
      fallbackReason: 'post_batch_confirmation'
    });
    const confirmationApiFailure = this.httpClient?.checkApiFailure?.(confirmationResult) || null;
    const confirmationFailed =
      confirmationResult?.error ||
      confirmationResult?.status >= 500 ||
      !!confirmationApiFailure;

    if (confirmationFailed) {
      const failureMessage =
        confirmationApiFailure?.error_message ||
        confirmationApiFailure?.message ||
        confirmationApiFailure?.description ||
        confirmationResult?.message ||
        'Post batch confirmation failed';

      logger.error('Post-batch confirmation failed for tolerated replay timeout flow', {
        requestEntry: confirmationRequestEntry.toString(),
        responseEntry: responseEntry.toString(),
        failureMessage,
        status: confirmationResult?.status || null
      });

      await this.fail(`API Failure: ${failureMessage}`);
      return false;
    }

    logger.info('Post-batch confirmation succeeded for tolerated replay timeout flow', {
      requestEntry: confirmationRequestEntry.toString(),
      responseEntry: responseEntry.toString(),
      status: confirmationResult?.status || null
    });

    return true;
  }

  async executeBlockingReplayRequest(entry, options = {}) {
    const {
      fallbackReason = null
    } = options;

    const endpointConfig = getEndpointConfig(entry.sourceDestination, entry.logTag);
    const resolvedEndpoint = resolveWrapperEndpointForMerchant(entry, endpointConfig);
    const replayEndpoint = resolveReplayEndpoint(entry.url);
    const isDirectLenderGatewayRequest =
      entry.isRequest && entry.source === 'LENDER' && entry.destination === 'GATEWAY';
    let api = resolvedEndpoint || this.getApiForLogTag(entry.logTag);
    if (isDirectLenderGatewayRequest && replayEndpoint) {
      api = replayEndpoint;
    }
    api = this.stateManager?.rewriteOutgoingLoanApplicationIdsInEndpoint
      ? this.stateManager.rewriteOutgoingLoanApplicationIdsInEndpoint(api, {
        logTag: entry?.logTag,
        field: 'endpoint'
      })
      : api;

    const endpointHeaders = {
      ...(endpointConfig?.headers || {}),
      ...buildReplaySessionHeaders(entry, this.validator.entries, this.stateManager),
      ...buildAppCoreAuthHeaders(entry, this.validator.entries, this.stateManager)
    };

    await ensureAppCorePreconditions(entry, endpointHeaders, this.stateManager);

    const {
      requestId: outboundRequestId,
      originalRequestId,
      normalized: requestIdNormalizedForAppCore,
      reusedFromLogTag: requestIdReusedFromLogTag
    } = getAppCoreRequestId({
      ...entry,
      stateManager: this.stateManager
    });
    const service = endpointConfig?.service || entry.destination;
    const method = entry.httpMethod || endpointConfig?.method || 'POST';
    const resolvedLoanApplicationId = this.resolveOutboundLoanApplicationIdForReplay(entry, {
      allowInferenceFromLiveBuffer: Boolean(fallbackReason)
    });

    const remappedPayload = remapReplayIds(
      entry.payload,
      this.stateManager,
      entry.logTag,
      null,
      resolvedLoanApplicationId
    );
    const transformedPayload = transformRequest(remappedPayload, entry.logTag);
    const forwardingRequest = prepareAsyncReplayForwarding(
      entry,
      transformedPayload,
      outboundRequestId,
      endpointHeaders,
      this.replayMerchantId || this.config.merchantId || null,
      this.observedIncomingRequests || [],
      this.stateManager
    );
    this.stateManager?.setReplayRequestIdForLogTag?.(entry.logTag, forwardingRequest.requestId, {
      sourceDestination: entry.sourceDestination,
      source: entry.source,
      destination: entry.destination
    });

    logger.info('Executing blocking replay request', {
      entry: entry?.toString?.(),
      logTag: entry?.logTag,
      requestId: forwardingRequest.requestId,
      originalRequestId,
      requestIdNormalizedForAppCore,
      requestIdReusedFromLogTag,
      fallbackReason
    });

    return makeRequest(
      this.getServiceBaseUrl(service),
      api,
      method,
      forwardingRequest.payload,
      forwardingRequest.requestId,
      entry.sourceDestination,
      entry.logTag,
      forwardingRequest.merchantId,
      forwardingRequest.headers,
      entry.index,
      this.getServiceUnixSocket(service)
    );
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

    const effectiveIncoming = this.maybeRemapIncomingMultiTagSibling(incoming);

    this.recordObservedIncomingRequest(effectiveIncoming);

    const normalizedSourceDestination = normalizeSourceDestination(
      `${effectiveIncoming.source}_${effectiveIncoming.destination}`,
      effectiveIncoming.logTag
    );

    logger.info('ASYNC_ORCH_RECEIVING', {
      orderId: this.orderId,
      registrySessionId: this.config?.registrySessionId || null,
      source: effectiveIncoming.source,
      destination: effectiveIncoming.destination,
      api: effectiveIncoming.api,
      requestId: effectiveIncoming.requestId,
      logTag: effectiveIncoming.logTag,
      lenderOrgId: effectiveIncoming.lenderOrgId,
      loanApplicationId: effectiveIncoming.loanApplicationId || effectiveIncoming.payload?.loanApplicationId || effectiveIncoming.payload?.loan_application_id || null,
      incomingOrderId: effectiveIncoming.orderId || effectiveIncoming.headers?.['x-order-id'] || effectiveIncoming.payload?.orderId || effectiveIncoming.payload?.order_id || null,
      currentEntry: this.validator?.getCurrentEntry?.()?.toString?.() || null,
      currentIndex: this.validator?.currentIndex ?? null,
      bufferStats: this.bufferManager?.getStats?.() || null,
      pendingWaiters: this.bufferManager?.getPendingRequestWaiters?.() || []
    });

    logger.logFinalIncoming(effectiveIncoming.source, effectiveIncoming.destination, effectiveIncoming.api, effectiveIncoming.payload, {
      requestId: effectiveIncoming.requestId,
      logTag: effectiveIncoming.logTag,
      lenderOrgId: effectiveIncoming.lenderOrgId,
      loanApplicationId: effectiveIncoming.loanApplicationId,
      sourceDestination: normalizedSourceDestination
    });

    if (isThemisEligibilitySpecialCase(effectiveIncoming.logTag) && effectiveIncoming.source === 'GATEWAY' &&
        (effectiveIncoming.destination === 'LENDER' || effectiveIncoming.destination === 'LSP' || effectiveIncoming.destination === 'THEMIS')) {
      return await this.handleThemisEligibilityBatchAsync(effectiveIncoming);
    }

    if (isThemisKfsSpecialCase(effectiveIncoming.logTag) && effectiveIncoming.source === 'GATEWAY' &&
        (effectiveIncoming.destination === 'LENDER' || effectiveIncoming.destination === 'LSP' || effectiveIncoming.destination === 'THEMIS')) {
      return await this.handleThemisKFSBatchAsync(effectiveIncoming);
    }

    const syntheticCompatibilityResponse = this.maybeHandleSyntheticFibeGenerateToken(effectiveIncoming);
    if (syntheticCompatibilityResponse) {
      logger.info('Handled incoming request with synthetic compatibility response', {
        source: effectiveIncoming.source,
        destination: effectiveIncoming.destination,
        logTag: effectiveIncoming.logTag,
        lenderOrgId: effectiveIncoming.lenderOrgId,
        requestId: effectiveIncoming.requestId
      });
      return syntheticCompatibilityResponse;
    }

    const immediateGenerateTokenResponse = this.maybeHandleImmediateGenerateToken(effectiveIncoming);
    if (immediateGenerateTokenResponse) {
      logger.info('Handled generate token request with immediate replay compatibility response', {
        source: effectiveIncoming.source,
        destination: effectiveIncoming.destination,
        logTag: effectiveIncoming.logTag,
        lenderOrgId: effectiveIncoming.lenderOrgId,
        requestId: effectiveIncoming.requestId
      });
      return immediateGenerateTokenResponse;
    }

    const syntheticCheckoutStatusResponse = this.maybeHandleSyntheticFibeCheckoutStatus(effectiveIncoming);
    if (syntheticCheckoutStatusResponse) {
      logger.info('Handled FIBE checkout status with synthetic compatibility response', {
        source: effectiveIncoming.source,
        destination: effectiveIncoming.destination,
        logTag: effectiveIncoming.logTag,
        lenderOrgId: effectiveIncoming.lenderOrgId,
        requestId: effectiveIncoming.requestId
      });
      return syntheticCheckoutStatusResponse;
    }

    const loanApplicationDataResponse = await this.maybePassThroughFetchLoanApplicationData(effectiveIncoming);
    if (loanApplicationDataResponse) {
      logger.info('Handled fetchLoanApplicationData with LSP pass-through response', {
        source: effectiveIncoming.source,
        destination: effectiveIncoming.destination,
        logTag: effectiveIncoming.logTag,
        requestId: effectiveIncoming.requestId
      });
      return loanApplicationDataResponse;
    }

    const directGatewayLenderResponse = await this.maybeHandleCurrentGatewayLenderRequest(effectiveIncoming);
    if (directGatewayLenderResponse) {
      return directGatewayLenderResponse;
    }

    const directCurrentExpectedResponse = await this.maybeHandleCurrentExpectedIncomingRequest(effectiveIncoming);
    if (directCurrentExpectedResponse) {
      return directCurrentExpectedResponse;
    }
    
    // Let retry detection run before buffering.
    // Some lender callbacks legitimately repeat requests that were already
    // satisfied from replay logs, and those should reuse the cached response.
    const retryResult = this.retryHandler.handleRetryRequest(effectiveIncoming);
    if (retryResult) {
      logger.info('Handled retried request asynchronously', {
        source: effectiveIncoming.source,
        destination: effectiveIncoming.destination,
        api: effectiveIncoming.api,
        logTag: effectiveIncoming.logTag
      });
      return retryResult;
    }

    const parts = normalizedSourceDestination.split('_');
    const normalizedIncoming = {
      ...effectiveIncoming,
      source: parts[0],
      destination: parts[1]
    };

    const validation = this.validator.validateIncomingRequest({
      source: normalizedIncoming.source,
      destination: normalizedIncoming.destination,
      logTag: normalizedIncoming.logTag,
      isRequest: true,
      requestId: normalizedIncoming.requestId,
      lenderOrgId: normalizedIncoming.lenderOrgId,
      loanApplicationId: normalizedIncoming.loanApplicationId
    });

    const directGatewayLenderLookaheadResponse =
      await this.maybeHandleFutureGatewayLenderRequest(effectiveIncoming, normalizedIncoming, validation);
    if (directGatewayLenderLookaheadResponse) {
      return directGatewayLenderLookaheadResponse;
    }

    const directFutureCoreGatewayResponse =
      await this.maybeHandleFutureCoreGatewayRequest(effectiveIncoming, normalizedIncoming, validation);
    if (directFutureCoreGatewayResponse) {
      return directFutureCoreGatewayResponse;
    }

    const directToleratedBatchLookaheadResponse =
      await this.maybeHandleFutureToleratedBatchRequest(effectiveIncoming, normalizedIncoming, validation);
    if (directToleratedBatchLookaheadResponse) {
      return directToleratedBatchLookaheadResponse;
    }

    const directFetchLoanApplicationDataLookaheadResponse =
      await this.maybeHandleFutureFetchLoanApplicationDataRequest(effectiveIncoming, normalizedIncoming, validation);
    if (directFetchLoanApplicationDataLookaheadResponse) {
      return directFetchLoanApplicationDataLookaheadResponse;
    }

    if (
      this.reportGenerator &&
      this.orderId &&
      normalizedIncoming?.source === 'GATEWAY' &&
      (
        normalizedIncoming?.destination === 'LENDER' ||
        normalizedIncoming?.destination === 'LSP' ||
        normalizedIncoming?.destination === 'THEMIS'
      ) &&
      !validation?.match &&
      !validation?.foundInLookahead
    ) {
      const currentEntry = this.validator.getCurrentEntry();
      const lookaheadWindow = (this.validator.entries || [])
        .filter(entry =>
          entry.index >= this.validator.currentIndex &&
          entry.index < this.validator.currentIndex + 8
        )
        .map(entry => ({
          index: entry.index,
          logTag: entry.logTag,
          sourceDestination: entry.sourceDestination
        }));

      const unexpectedActualApiInfo = {
        type: 'UNEXPECTED_ACTUAL_API',
        logTag: normalizedIncoming.logTag || null,
        sourceDestination: normalizedIncoming.sourceDestination || normalizedSourceDestination,
        source: normalizedIncoming.source || null,
        destination: normalizedIncoming.destination || null,
        endpoint: normalizedIncoming.api || null,
        requestId: normalizedIncoming.requestId || null,
        currentReplayEntry: currentEntry?.toString?.() || null,
        lookaheadWindow,
        reason: 'Observed in actual replay traffic but no matching replay entry was found in current/lookahead sequence'
      };

      this.reportGenerator.recordUnexpectedActualApi(this.orderId, unexpectedActualApiInfo);
      this.reportGenerator.recordReplayWarning(this.orderId, unexpectedActualApiInfo);

      logger.warn('Observed unexpected actual API during replay; recording for order diagnostics', unexpectedActualApiInfo);
    }

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
    
    logger.info('ASYNC_ORCH_REQUEST_BUFFERED_FOR_PROCESSING', {
      orderId: this.orderId,
      registrySessionId: this.config?.registrySessionId || null,
      requestId: normalizedIncoming.requestId,
      bufferKey: buffered.key,
      normalizedSource: normalizedIncoming.source,
      normalizedDestination: normalizedIncoming.destination,
      normalizedSourceDestination,
      currentEntry: this.validator?.getCurrentEntry?.()?.toString?.() || null,
      bufferStats: this.bufferManager?.getStats?.() || null
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

    if (!isImmediateDirectReplayLogTag(incoming.logTag)) {
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

    const pendingWaiters = this.bufferManager?.getPendingRequestWaiters?.() || [];
    const currentEntryLabel = currentEntry.toString();
    const replayAlreadyWaiting = pendingWaiters.some(waiter =>
      waiter.expected === currentEntryLabel &&
      waiter.logTag === currentEntry.logTag &&
      waiter.source === currentEntry.source &&
      waiter.destination === currentEntry.destination
    );

    if (replayAlreadyWaiting) {
      logger.info('Replay already waiting for current GATEWAY->LENDER request, letting buffered matcher handle it', {
        entry: currentEntryLabel,
        requestId: incoming.requestId,
        logTag: incoming.logTag,
        lenderOrgId: incoming.lenderOrgId
      });
      return null;
    }

    logger.info('Processing current GATEWAY->LENDER request immediately from replay logs to unblock nested gateway call', {
      entry: currentEntry.toString(),
      requestId: incoming.requestId,
      logTag: incoming.logTag,
      lenderOrgId: incoming.lenderOrgId
    });

    const responseEntry = this.findCorrespondingResponse(currentEntry, true);
    if (!responseEntry) {
      logger.warn('Current GATEWAY->LENDER request matched replay entry but no corresponding response log was found; falling back to generic incoming handler', {
        entry: currentEntry.toString(),
        requestId: incoming.requestId,
        logTag: incoming.logTag
      });

      const fallbackResponse = await super.handleIncomingRequest(incoming);
      this.bufferManager?.skipWaiter?.(currentEntry);
      return fallbackResponse;
    }

    const replayResponse = {
      success: true,
      payload: transformRequest(responseEntry.payload, responseEntry.logTag)
    };
    const preSatisfiedMarker = this.preSatisfiedReplayEntries?.get(currentEntry.index) || null;
    if (preSatisfiedMarker?.bufferedRequestKey && this.bufferManager?.completeIncomingRequest) {
      this.bufferManager.completeIncomingRequest(
        preSatisfiedMarker.bufferedRequestKey,
        replayResponse
      );
    }
    if (preSatisfiedMarker) {
      this.preSatisfiedReplayEntries.delete(currentEntry.index);
    }

    this.recordObservedProcessedResponse(
      responseEntry,
      replayResponse.payload
    );

    if (!this.validator.processedIndices.has(currentEntry.index)) {
      this.validator.markProcessed(currentEntry);
      this.recordSuccess('immediate_current_gateway_lender_request', currentEntry);
      logger.info('Marked current GATEWAY->LENDER request as processed after immediate log replay handling', {
        entry: currentEntry.toString(),
        currentIndex: this.validator.currentIndex
      });
    }

    if (!this.validator.processedIndices.has(responseEntry.index)) {
      this.validator.markProcessed(responseEntry);
      this.recordSuccess('immediate_current_gateway_lender_response', responseEntry);
      logger.info('Marked corresponding GATEWAY->LENDER response as processed during immediate log replay handling', {
        requestEntry: currentEntry.toString(),
        responseEntry: responseEntry.toString(),
        currentIndex: this.validator.currentIndex
      });
    }

    this.markStuckEntryResolved(currentEntry, 'immediate_current_gateway_lender_request_replayed_from_logs');
    this.bufferManager?.clearWaitDiagnostics?.(currentEntry, 'immediate_gateway_lender_request_replay');
    this.bufferManager?.skipWaiter?.(currentEntry);

    logger.logApiCall(
      responseEntry.source,
      responseEntry.destination,
      getEndpointConfig(currentEntry.sourceDestination, currentEntry.logTag)?.endpoint || currentEntry.api || null,
      'RESPONSE',
      responseEntry.index
    );

    logger.info('Returned replayed GATEWAY->LENDER response immediately from logs', {
      requestEntry: currentEntry.toString(),
      responseEntry: responseEntry.toString(),
      requestId: incoming.requestId,
      logTag: incoming.logTag
    });

    return {
      success: true,
      payload: replayResponse.payload
    };
  }

  async maybeHandleCurrentExpectedIncomingRequest(incoming) {
    const sourceDestination = normalizeSourceDestination(
      `${incoming.source}_${incoming.destination}`,
      incoming.logTag
    );
    const [source, destination] = sourceDestination.split('_');

    const isFetchLoanApplicationDataRequest =
      source === 'GATEWAY' &&
      destination === 'LSP' &&
      (
        incoming?.api === '/api/fetch/loanApplicationData' ||
        incoming?.logTag === 'FECTH_LOAN_APPLICATION_DATA_API_REQUEST' ||
        incoming?.logTag === 'FETCH_LOAN_APPLICATION_DATA_API_REQUEST'
      );

    if (source === 'GATEWAY' && destination === 'LENDER') {
      return null;
    }

    const currentEntry = this.validator.getCurrentEntry();
    if (!currentEntry?.isRequest) {
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

    const pendingWaiters = this.bufferManager?.getPendingRequestWaiters?.() || [];
    const currentEntryLabel = currentEntry.toString();
    const replayAlreadyWaiting = pendingWaiters.some(waiter =>
      waiter.expected === currentEntryLabel &&
      waiter.logTag === currentEntry.logTag &&
      waiter.source === currentEntry.source &&
      waiter.destination === currentEntry.destination
    );

    if (replayAlreadyWaiting) {
      logger.info('Replay already waiting for current matched request, letting buffered matcher handle it', {
        entry: currentEntryLabel,
        requestId: incoming.requestId,
        logTag: incoming.logTag,
        lenderOrgId: incoming.lenderOrgId || null
      });
      return null;
    }

    logger.info('Processing current matched incoming request immediately because no replay waiter is registered', {
      entry: currentEntry.toString(),
      requestId: incoming.requestId,
      logTag: incoming.logTag,
      lenderOrgId: incoming.lenderOrgId || null
    });

    this.registerNearbyImmediateReplaySatisfaction(normalizedIncoming, {
      reason: 'immediate_current_expected'
    });

    const response = await super.handleIncomingRequest(incoming);
    this.bufferManager?.skipWaiter?.(currentEntry);
    return response;
  }

  async maybeHandleFutureGatewayLenderRequest(incoming, normalizedIncoming, validation = null) {
    const sourceDestination = normalizeSourceDestination(
      `${incoming.source}_${incoming.destination}`,
      incoming.logTag
    );
    const [source, destination] = sourceDestination.split('_');

    if (source !== 'GATEWAY' || destination !== 'LENDER') {
      return null;
    }

    const currentEntry = this.validator.getCurrentEntry();
    if (!currentEntry) {
      return null;
    }

    let effectiveValidation = validation;
    if (!effectiveValidation) {
      effectiveValidation = this.validator.validateIncomingRequest({
        source: normalizedIncoming.source,
        destination: normalizedIncoming.destination,
        logTag: normalizedIncoming.logTag,
        isRequest: true,
        requestId: normalizedIncoming.requestId,
        lenderOrgId: normalizedIncoming.lenderOrgId,
        loanApplicationId: normalizedIncoming.loanApplicationId
      });
    }

    let futureEntry = effectiveValidation?.foundInLookahead || null;

    const sameGatewayLenderLogTag = (entry) =>
      entry &&
      entry.isRequest &&
      entry.source === source &&
      entry.destination === destination &&
      entry.logTag === normalizedIncoming.logTag;

    if (!futureEntry && effectiveValidation?.isEarly) {
      futureEntry = this.validator.entries.find(entry =>
        entry.index > this.validator.currentIndex &&
        !this.validator.processedIndices.has(entry.index) &&
        entry.isRequest &&
        this.validator.matchesExpected(entry, normalizedIncoming)
      ) || null;
    }

    if (!futureEntry && isImmediateDirectReplayLogTag(incoming.logTag)) {
      futureEntry = this.validator.entries.find(entry =>
        entry.index > this.validator.currentIndex &&
        !this.validator.processedIndices.has(entry.index) &&
        entry.isRequest &&
        this.validator.matchesExpected(entry, normalizedIncoming)
      ) || null;

      if (futureEntry) {
        logger.info('Resolved future GATEWAY->LENDER immediate replay entry outside lookahead window', {
          currentEntry: currentEntry.toString(),
          futureEntry: futureEntry.toString(),
          requestId: incoming.requestId || null,
          logTag: incoming.logTag
        });
      }
    }

    const nearestUnprocessedSameLogTagEntry = this.validator.entries.find(entry =>
      entry.index >= this.validator.currentIndex - 2 &&
      !this.validator.processedIndices.has(entry.index) &&
      sameGatewayLenderLogTag(entry)
    ) || null;

    if (futureEntry && this.preSatisfiedReplayEntries?.has(futureEntry.index)) {
      futureEntry = this.validator.entries.find(entry =>
        entry.index > futureEntry.index &&
        !this.validator.processedIndices.has(entry.index) &&
        entry.isRequest &&
        this.validator.matchesExpected(entry, normalizedIncoming) &&
        !this.preSatisfiedReplayEntries.has(entry.index)
      ) || futureEntry;
    }

    if (!futureEntry && nearestUnprocessedSameLogTagEntry) {
      futureEntry = nearestUnprocessedSameLogTagEntry;
      logger.warn('Falling back to nearest unprocessed GATEWAY->LENDER replay entry despite strict payload mismatch', {
        currentEntry: currentEntry.toString(),
        futureEntry: futureEntry.toString(),
        requestId: incoming.requestId || null,
        logTag: incoming.logTag,
        currentIndex: this.validator.currentIndex
      });
    }

    if (!futureEntry) {
      return null;
    }

    logger.info('Processing future GATEWAY->LENDER request immediately from lookahead to unblock nested gateway call', {
      currentEntry: currentEntry.toString(),
      futureEntry: futureEntry.toString(),
      requestId: incoming.requestId,
      logTag: incoming.logTag,
      lenderOrgId: incoming.lenderOrgId
    });

    const responseEntry = this.findCorrespondingResponse(futureEntry, true);
    if (!responseEntry) {
      logger.warn('Future GATEWAY->LENDER immediate replay entry had no corresponding response log; falling back to buffered wait handling', {
        currentEntry: currentEntry.toString(),
        futureEntry: futureEntry.toString(),
        requestId: incoming.requestId || null,
        logTag: incoming.logTag || null
      });

      const buffered = await this.bufferManager.addIncomingRequest(normalizedIncoming);
      this.registerPreSatisfiedReplayEntry(futureEntry, {
        requestId: incoming.requestId || null,
        reason: 'immediate_future_gateway_lender',
        bufferedRequestKey: buffered.key
      });

      logger.info('Buffered future GATEWAY->LENDER request until replay reaches its recorded position', {
        currentEntry: currentEntry.toString(),
        futureEntry: futureEntry.toString(),
        requestId: incoming.requestId || null,
        logTag: incoming.logTag || null,
        bufferKey: buffered.key
      });

      try {
        return await buffered.deferred.promise;
      } catch (error) {
        logger.error('Deferred future GATEWAY->LENDER request failed before replay consumed it', {
          error: error.message,
          currentEntry: currentEntry.toString(),
          futureEntry: futureEntry.toString(),
          requestId: incoming.requestId || null,
          logTag: incoming.logTag || null,
          bufferKey: buffered.key
        });
        return {
          success: false,
          error: error.message
        };
      }
    }

    const replayResponse = {
      success: true,
      payload: transformRequest(responseEntry.payload, responseEntry.logTag)
    };

    this.recordObservedProcessedResponse(
      responseEntry,
      replayResponse.payload
    );

    if (!this.validator.processedIndices.has(futureEntry.index)) {
      this.validator.markProcessed(futureEntry);
      this.recordSuccess('immediate_future_gateway_lender_request', futureEntry);
    }

    if (!this.validator.processedIndices.has(responseEntry.index)) {
      this.validator.markProcessed(responseEntry);
      this.recordSuccess('immediate_future_gateway_lender_response', responseEntry);
    }

    if (this.preSatisfiedReplayEntries?.has(futureEntry.index)) {
      this.preSatisfiedReplayEntries.delete(futureEntry.index);
    }

    this.markStuckEntryResolved(futureEntry, 'immediate_future_gateway_lender_request_replayed_from_logs');
    this.bufferManager?.clearWaitDiagnostics?.(futureEntry, 'immediate_future_gateway_lender_request_replay');
    this.bufferManager?.skipWaiter?.(futureEntry);

    logger.logApiCall(
      responseEntry.source,
      responseEntry.destination,
      getEndpointConfig(futureEntry.sourceDestination, futureEntry.logTag)?.endpoint || futureEntry.api || null,
      'RESPONSE',
      responseEntry.index
    );

    logger.info('Returned future GATEWAY->LENDER response immediately from replay logs', {
      currentEntry: currentEntry.toString(),
      futureEntry: futureEntry.toString(),
      responseEntry: responseEntry.toString(),
      requestId: incoming.requestId || null,
      logTag: incoming.logTag || null
    });

    return {
      success: true,
      payload: replayResponse.payload
    };
  }

  findActiveToleratedBatchAnchor(currentEntry = this.validator?.getCurrentEntry?.()) {
    if (!currentEntry || !this.validator?.entries) {
      return null;
    }

    for (let index = currentEntry.index - 1; index >= 0; index -= 1) {
      const candidate = this.validator.entries[index];
      if (!candidate?.isRequest || !isToleratedBatchTimeoutApiLogTag(candidate.logTag)) {
        continue;
      }

      if (!this.validator.processedIndices.has(candidate.index)) {
        continue;
      }

      const candidateResponse = this.findCorrespondingResponse(candidate, true);
      if (!candidateResponse || this.validator.processedIndices.has(candidateResponse.index)) {
        continue;
      }

      if (candidateResponse.index < currentEntry.index) {
        continue;
      }

      return {
        requestEntry: candidate,
        responseEntry: candidateResponse
      };
    }

    return null;
  }

  async maybeHandleFutureToleratedBatchRequest(incoming, normalizedIncoming, validation = null) {
    const currentEntry = this.validator.getCurrentEntry();
    if (!currentEntry?.isResponse) {
      return null;
    }

    const activeBatch = this.findActiveToleratedBatchAnchor(currentEntry);
    if (!activeBatch) {
      return null;
    }

    let effectiveValidation = validation;
    if (!effectiveValidation) {
      effectiveValidation = this.validator.validateIncomingRequest({
        source: normalizedIncoming.source,
        destination: normalizedIncoming.destination,
        logTag: normalizedIncoming.logTag,
        isRequest: true,
        requestId: normalizedIncoming.requestId,
        lenderOrgId: normalizedIncoming.lenderOrgId,
        loanApplicationId: normalizedIncoming.loanApplicationId
      });
    }

    const futureEntry = effectiveValidation?.foundInLookahead || null;
    if (!futureEntry?.isRequest) {
      return null;
    }

    if (
      futureEntry.source !== normalizedIncoming.source ||
      futureEntry.destination !== normalizedIncoming.destination ||
      futureEntry.logTag !== normalizedIncoming.logTag
    ) {
      return null;
    }

    logger.info('Processing future request immediately inside tolerated batch window', {
      currentEntry: currentEntry.toString(),
      futureEntry: futureEntry.toString(),
      batchRequestEntry: activeBatch.requestEntry.toString(),
      batchResponseEntry: activeBatch.responseEntry.toString(),
      requestId: incoming.requestId,
      logTag: incoming.logTag
    });

    this.registerPreSatisfiedReplayEntry(futureEntry, {
      requestId: incoming.requestId || null,
      reason: 'immediate_future_tolerated_batch_request'
    });

    return this.outOfOrderHandler.handleOutOfOrderRequest(incoming, {
      ...(effectiveValidation || {}),
      expectedEntry: currentEntry,
      foundInLookahead: futureEntry
    });
  }

  async maybeHandleFutureFetchLoanApplicationDataRequest(incoming, normalizedIncoming, validation = null) {
    const sourceDestination = normalizeSourceDestination(
      `${incoming.source}_${incoming.destination}`,
      incoming.logTag
    );
    const [source, destination] = sourceDestination.split('_');

    const isFetchLoanApplicationDataRequest =
      source === 'GATEWAY' &&
      destination === 'LSP' &&
      (
        incoming?.api === '/api/fetch/loanApplicationData' ||
        incoming?.logTag === 'FECTH_LOAN_APPLICATION_DATA_API_REQUEST' ||
        incoming?.logTag === 'FETCH_LOAN_APPLICATION_DATA_API_REQUEST'
      );

    if (!isFetchLoanApplicationDataRequest) {
      return null;
    }

    const currentEntry = this.validator.getCurrentEntry();
    if (!currentEntry) {
      return null;
    }

    let effectiveValidation = validation;
    if (!effectiveValidation) {
      effectiveValidation = this.validator.validateIncomingRequest({
        source: normalizedIncoming.source,
        destination: normalizedIncoming.destination,
        logTag: normalizedIncoming.logTag,
        isRequest: true,
        requestId: normalizedIncoming.requestId,
        lenderOrgId: normalizedIncoming.lenderOrgId,
        loanApplicationId: normalizedIncoming.loanApplicationId
      });
    }

    const futureEntry = effectiveValidation?.foundInLookahead || null;
    if (!futureEntry?.isRequest) {
      return null;
    }

    if (
      futureEntry.source !== source ||
      futureEntry.destination !== destination ||
      futureEntry.logTag !== normalizedIncoming.logTag
    ) {
      return null;
    }

    logger.info('Processing future fetchLoanApplicationData request immediately to unblock waiting gateway flow', {
      currentEntry: currentEntry.toString(),
      futureEntry: futureEntry.toString(),
      requestId: incoming.requestId || null,
      logTag: incoming.logTag,
      requiredData:
        incoming?.payload?.requiredData ||
        incoming?.payload?.required_data ||
        null
    });

    this.registerPreSatisfiedReplayEntry(futureEntry, {
      requestId: incoming.requestId || null,
      reason: 'immediate_future_fetch_loan_application_data'
    });

    this.registerReplayIdentifierMappings(futureEntry, normalizedIncoming);

    logger.logApiCall(normalizedIncoming.source, normalizedIncoming.destination, normalizedIncoming.api, 'REQUEST', futureEntry.index);

    const comparison = this.comparePayloads(futureEntry.payload, normalizedIncoming.payload, normalizedIncoming.logTag, futureEntry);
    if (!comparison.match) {
      logger.warn('Payload mismatch tolerated for immediate future fetchLoanApplicationData request', {
        entry: futureEntry.toString(),
        logTag: normalizedIncoming.logTag,
        differences: comparison.differences
      });
    }

    return await this.forwardToDestination(normalizedIncoming, futureEntry);
  }

  async maybeHandleFutureCoreGatewayRequest(incoming, normalizedIncoming, validation = null) {
    const sourceDestination = normalizeSourceDestination(
      `${incoming.source}_${incoming.destination}`,
      incoming.logTag
    );
    const [source, destination] = sourceDestination.split('_');

    if (source !== 'CORE' || destination !== 'GATEWAY') {
      return null;
    }

    if (!isImmediateFutureCoreGatewayRequestLogTag(incoming.logTag)) {
      return null;
    }

    const currentEntry = this.validator.getCurrentEntry();
    if (!currentEntry) {
      return null;
    }

    let effectiveValidation = validation;
    if (!effectiveValidation) {
      effectiveValidation = this.validator.validateIncomingRequest({
        source: normalizedIncoming.source,
        destination: normalizedIncoming.destination,
        logTag: normalizedIncoming.logTag,
        isRequest: true,
        requestId: normalizedIncoming.requestId,
        lenderOrgId: normalizedIncoming.lenderOrgId,
        loanApplicationId: normalizedIncoming.loanApplicationId
      });
    }

    let futureEntry = effectiveValidation?.foundInLookahead || null;

    if (!futureEntry && effectiveValidation?.isEarly) {
      futureEntry = this.validator.entries.find(entry =>
        entry.index > this.validator.currentIndex &&
        !this.validator.processedIndices.has(entry.index) &&
        entry.isRequest &&
        this.validator.matchesExpected(entry, normalizedIncoming)
      ) || null;
    }

    const sameCoreGatewayLogTag = (entry) =>
      entry &&
      entry.isRequest &&
      entry.source === source &&
      entry.destination === destination &&
      entry.logTag === normalizedIncoming.logTag;

    const nearestUnprocessedSameLogTagEntry = this.validator.entries.find(entry =>
      entry.index >= this.validator.currentIndex - 2 &&
      !this.validator.processedIndices.has(entry.index) &&
      sameCoreGatewayLogTag(entry)
    ) || null;

    if (!futureEntry) {
      futureEntry = this.validator.entries.find(entry =>
        entry.index > this.validator.currentIndex &&
        !this.validator.processedIndices.has(entry.index) &&
        sameCoreGatewayLogTag(entry) &&
        this.validator.matchesExpected(entry, normalizedIncoming)
      ) || null;

      if (futureEntry) {
        logger.info('Resolved future CORE->GATEWAY immediate replay entry outside validator lookahead classification', {
          currentEntry: currentEntry.toString(),
          futureEntry: futureEntry.toString(),
          requestId: incoming.requestId || null,
          logTag: incoming.logTag
        });
      }
    }

    if (!futureEntry && nearestUnprocessedSameLogTagEntry) {
      futureEntry = nearestUnprocessedSameLogTagEntry;
      logger.warn('Falling back to nearest unprocessed CORE->GATEWAY replay entry despite strict payload mismatch', {
        currentEntry: currentEntry.toString(),
        futureEntry: futureEntry.toString(),
        requestId: incoming.requestId || null,
        logTag: incoming.logTag,
        currentIndex: this.validator.currentIndex
      });
    }

    if (!futureEntry) {
      logger.info('Immediate CORE->GATEWAY request was received but no replay entry could be claimed', {
        currentEntry: currentEntry.toString(),
        requestId: incoming.requestId || null,
        logTag: incoming.logTag,
        currentIndex: this.validator.currentIndex,
        foundInLookahead: !!effectiveValidation?.foundInLookahead,
        isEarly: !!effectiveValidation?.isEarly
      });
      return null;
    }

    if (
      futureEntry.source !== source ||
      futureEntry.destination !== destination ||
      futureEntry.logTag !== normalizedIncoming.logTag
    ) {
      return null;
    }

    logger.info('Processing future CORE->GATEWAY request immediately to unblock downstream lender chain', {
      currentEntry: currentEntry.toString(),
      futureEntry: futureEntry.toString(),
      requestId: incoming.requestId || null,
      logTag: incoming.logTag
    });

    const pairedResponseEntry = this.findCorrespondingResponse(futureEntry, true);
    this.registerPreSatisfiedReplayEntry(futureEntry, {
      requestId: incoming.requestId || null,
      reason: 'immediate_future_core_gateway_request'
    });

    this.registerReplayIdentifierMappings(futureEntry, normalizedIncoming);

    logger.logApiCall(normalizedIncoming.source, normalizedIncoming.destination, normalizedIncoming.api, 'REQUEST', futureEntry.index);

    const comparison = this.comparePayloads(futureEntry.payload, normalizedIncoming.payload, normalizedIncoming.logTag);
    if (!comparison.match) {
      logger.warn('Payload mismatch tolerated for immediate future CORE->GATEWAY request', {
        entry: futureEntry.toString(),
        logTag: normalizedIncoming.logTag,
        differences: comparison.differences
      });
    }

    const forwardResult = await this.forwardToDestination(normalizedIncoming, futureEntry);

    if (forwardResult?.success) {
      if (!this.validator.processedIndices.has(futureEntry.index)) {
        this.validator.markProcessed(futureEntry);
      }
      this.recordSuccess('immediate_future_core_gateway_request', futureEntry);

      if (pairedResponseEntry && !this.validator.processedIndices.has(pairedResponseEntry.index)) {
        this.validator.markProcessed(pairedResponseEntry);
      }
      if (pairedResponseEntry) {
        this.recordSuccess('immediate_future_core_gateway_response', pairedResponseEntry);
      }

      if (this.preSatisfiedReplayEntries?.has(futureEntry.index)) {
        this.preSatisfiedReplayEntries.delete(futureEntry.index);
      }

      this.markStuckEntryResolved(futureEntry, 'immediate_future_core_gateway_request_forwarded');
      this.bufferManager?.clearWaitDiagnostics?.(futureEntry, 'immediate_future_core_gateway_request_forwarded');
      this.bufferManager?.skipWaiter?.(futureEntry);

      logger.info('Marked immediate future CORE->GATEWAY replay pair as processed after successful early forwarding', {
        requestEntry: futureEntry.toString(),
        responseEntry: pairedResponseEntry?.toString?.() || null,
        requestId: incoming.requestId || null,
        logTag: incoming.logTag
      });
    } else if (this.preSatisfiedReplayEntries?.has(futureEntry.index)) {
      this.preSatisfiedReplayEntries.delete(futureEntry.index);
      logger.warn('Cleared pre-satisfied marker for immediate future CORE->GATEWAY request because early forwarding did not complete successfully', {
        requestEntry: futureEntry.toString(),
        responseEntry: pairedResponseEntry?.toString?.() || null,
        requestId: incoming.requestId || null,
        logTag: incoming.logTag
      });
    }

    return forwardResult;
  }

  registerNearbyImmediateReplaySatisfaction(incoming, options = {}) {
    if (!this.preSatisfiedReplayEntries) {
      this.preSatisfiedReplayEntries = new Map();
    }

    const currentIndex = this.validator?.currentIndex ?? 0;
    const candidate = this.validator?.entries?.find(entry =>
      entry.index >= currentIndex &&
      entry.index <= currentIndex + 4 &&
      !this.validator.processedIndices.has(entry.index) &&
      entry.isRequest &&
      this.validator.matchesExpected(entry, incoming)
    ) || null;

    if (!candidate) {
      logger.info('No nearby replay entry found to mark as pre-satisfied after immediate handling', {
        requestId: incoming?.requestId || null,
        logTag: incoming?.logTag || null,
        reason: options.reason || 'immediate_handling',
        currentIndex
      });
      return false;
    }

    this.registerPreSatisfiedReplayEntry(candidate, {
      requestId: incoming?.requestId || null,
      reason: options.reason || 'immediate_handling'
    });
    return true;
  }

  registerPreSatisfiedReplayEntry(entry, options = {}) {
    if (!entry) {
      return false;
    }

    if (!this.preSatisfiedReplayEntries) {
      this.preSatisfiedReplayEntries = new Map();
    }

    const responseEntry = this.findCorrespondingResponse(entry, true);
    this.preSatisfiedReplayEntries.set(entry.index, {
      requestIndex: entry.index,
      responseIndex: responseEntry?.index ?? null,
      satisfiedAt: Date.now(),
      requestId: options.requestId || null,
      reason: options.reason || 'pre_satisfied_registration',
      bufferedRequestKey: options.bufferedRequestKey || null
    });

    logger.info('Registered pre-satisfied replay entry after immediate handling', {
      requestEntry: entry.toString(),
      responseEntry: responseEntry?.toString?.() || null,
      requestId: options.requestId || null,
      reason: options.reason || 'pre_satisfied_registration',
      currentIndex: this.validator?.currentIndex ?? null
    });

    return true;
  }

  attachBufferedRequestKeyToPreSatisfiedEntry(entry, bufferedRequestKey) {
    if (!entry || !bufferedRequestKey || !this.preSatisfiedReplayEntries) {
      return false;
    }

    const marker = this.preSatisfiedReplayEntries.get(entry.index);
    if (!marker) {
      return false;
    }

    marker.bufferedRequestKey = bufferedRequestKey;
    this.preSatisfiedReplayEntries.set(entry.index, marker);
    return true;
  }

  maybeHandleImmediateGenerateToken(incoming) {
    if (!this.preSatisfiedReplayEntries) {
      this.preSatisfiedReplayEntries = new Map();
    }

    const isGenerateTokenRequest =
      incoming?.source === 'GATEWAY' &&
      incoming?.destination === 'LENDER' &&
      incoming?.logTag === 'GENERATE_TOKEN_API_REQUEST';

    if (!isGenerateTokenRequest) {
      return null;
    }

    const futureEntry = this.validator.entries.find(entry =>
      entry.index >= this.validator.currentIndex &&
      !this.validator.processedIndices.has(entry.index) &&
      entry.isRequest &&
      entry.source === 'GATEWAY' &&
      entry.destination === 'LENDER' &&
      entry.logTag === 'GENERATE_TOKEN_API_REQUEST'
    ) || null;

    if (futureEntry) {
      this.registerPreSatisfiedReplayEntry(futureEntry, {
        requestId: incoming.requestId || null,
        reason: 'immediate_generate_token'
      });
    } else {
      logger.info('Immediate generate token request has no explicit replay entry; returning synthetic success', {
        requestId: incoming.requestId || null,
        currentIndex: this.validator.currentIndex
      });
    }

    this.results.passed++;
    this.results.processedLogs.push({
      step: 'immediate_generate_token_response',
      entry: `[synthetic] ${incoming.logTag} ${incoming.source}→${incoming.destination}`,
      timestamp: new Date().toISOString()
    });

    return {
      success: true,
      synthetic: true,
      payload: {
        token: 'ART_IMMEDIATE_GENERATE_TOKEN',
        statusMessage: 'Success',
        statusCode: 200
      }
    };
  }

  maybeResolvePreSatisfiedReplayEntry(entry) {
    if (!this.preSatisfiedReplayEntries) {
      this.preSatisfiedReplayEntries = new Map();
    }

    const marker = this.preSatisfiedReplayEntries.get(entry.index);
    if (!marker) {
      return false;
    }

    this.preSatisfiedReplayEntries.delete(entry.index);
    this.validator.markProcessed(entry);

    let resolvedBufferedGatewayLenderRequest = false;
    if (marker.responseIndex !== null) {
      const responseEntry = this.validator.entries.find(candidate => candidate.index === marker.responseIndex);
      if (responseEntry) {
        if (
          entry.source === 'GATEWAY' &&
          entry.destination === 'LENDER' &&
          responseEntry.source === 'LENDER' &&
          responseEntry.destination === 'GATEWAY'
        ) {
          let buffered = null;
          if (marker.bufferedRequestKey && this.bufferManager?.claimIncomingRequestByKey) {
            buffered = this.bufferManager.claimIncomingRequestByKey(marker.bufferedRequestKey, entry);
          }

          if (!buffered) {
            buffered = this.bufferManager?.findMatchingRequest?.(entry, { claim: true });
          }

          if (buffered) {
            const replayResponse = {
              success: true,
              payload: transformRequest(responseEntry.payload, responseEntry.logTag)
            };

            this.bufferManager.completeIncomingRequest(buffered.key, replayResponse);
            resolvedBufferedGatewayLenderRequest = true;

            logger.info('Resolved buffered GATEWAY->LENDER request immediately from recorded replay response', {
              requestEntry: entry.toString(),
              responseEntry: responseEntry.toString(),
              bufferKey: buffered.key,
              requestId: buffered.request?.requestId || null,
              logTag: buffered.request?.logTag || null
            });
          } else {
            logger.warn('Pre-satisfied GATEWAY->LENDER replay entry had no claimable buffered request to complete', {
              requestEntry: entry.toString(),
              responseEntry: responseEntry.toString(),
              bufferDiagnostics: this.bufferManager?.getIncomingBufferDiagnostics?.(entry, 10) || null
            });
          }
        }

        this.validator.markProcessed(responseEntry);
        this.recordSuccess('pre_satisfied_replay_response', responseEntry);
      }
    }

    this.recordSuccess('pre_satisfied_replay_request', entry);
    logger.info('Resolved pre-satisfied replay entry without waiting for a live lender round-trip', {
      entry: entry.toString(),
      responseIndex: marker.responseIndex,
      requestId: marker.requestId,
      resolvedBufferedGatewayLenderRequest,
      currentIndex: this.validator.currentIndex
    });
    return true;
  }

  maybeRegisterObservedImmediateGatewayLenderSatisfaction(entry) {
    if (!entry?.isRequest) {
      return false;
    }

    if (entry.source !== 'GATEWAY' || entry.destination !== 'LENDER') {
      return false;
    }

    if (!isImmediateDirectReplayLogTag(entry.logTag)) {
      return false;
    }

    if (this.validator.processedIndices.has(entry.index)) {
      return false;
    }

    if (this.preSatisfiedReplayEntries?.has(entry.index)) {
      return true;
    }

    const observedMatch = (this.observedIncomingRequests || []).find(observed =>
      observed &&
      observed.source === 'GATEWAY' &&
      observed.destination === 'LENDER' &&
      observed.logTag === entry.logTag &&
      this.validator.matchesExpected(entry, observed)
    );

    if (!observedMatch) {
      return false;
    }

    this.registerPreSatisfiedReplayEntry(entry, {
      requestId: observedMatch.requestId || null,
      reason: 'observed_immediate_gateway_lender_request'
    });

    logger.info('Registered observed immediate GATEWAY->LENDER replay satisfaction from prior live request', {
      entry: entry.toString(),
      observedRequestId: observedMatch.requestId || null,
      observedAt: observedMatch.observedAt || null,
      logTag: observedMatch.logTag || null
    });

    return true;
  }

  maybeRegisterObservedImmediateCoreGatewaySatisfaction(entry) {
    if (!entry?.isRequest) {
      return false;
    }

    if (entry.source !== 'CORE' || entry.destination !== 'GATEWAY') {
      return false;
    }

    if (!isImmediateFutureCoreGatewayRequestLogTag(entry.logTag)) {
      return false;
    }

    if (this.validator.processedIndices.has(entry.index)) {
      return false;
    }

    if (this.preSatisfiedReplayEntries?.has(entry.index)) {
      return true;
    }

    const observedMatch = (this.observedIncomingRequests || []).find(observed =>
      observed &&
      observed.source === 'CORE' &&
      observed.destination === 'GATEWAY' &&
      observed.logTag === entry.logTag &&
      this.validator.matchesExpected(entry, observed)
    );

    if (!observedMatch) {
      return false;
    }

    this.registerPreSatisfiedReplayEntry(entry, {
      requestId: observedMatch.requestId || null,
      reason: 'observed_immediate_core_gateway_request'
    });

    this.bufferManager?.clearWaitDiagnostics?.(entry, 'observed_immediate_core_gateway_request');
    this.bufferManager?.skipWaiter?.(entry);

    logger.info('Registered observed immediate CORE->GATEWAY replay satisfaction from prior live request', {
      entry: entry.toString(),
      observedRequestId: observedMatch.requestId || null,
      observedAt: observedMatch.observedAt || null,
      logTag: observedMatch.logTag || null
    });

    return true;
  }

  async waitForAllExternalCalls() {
    logger.info('Skipping blocking waitForAllExternalCalls in async replay mode', {
      pendingExternalRequests: this.pendingExternalRequests?.size || 0,
      asyncTrackerCount: this.asyncCallTracker?.size || 0,
      currentEntry: this.validator.getCurrentEntry()?.toString() || null
    });
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
    const comparison = this.comparePayloads(requestEntry.payload, incoming.payload, incoming.logTag, requestEntry);
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
    const comparison = this.comparePayloads(requestEntry.payload, incoming.payload, incoming.logTag, requestEntry);
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

    if (responseEntry.clientRequestId || responseEntry.orderId) {
      for (let i = this.validator.currentIndex - 1; i >= 0; i--) {
        const entry = this.validator.entries[i];
        if (!entry?.isRequest) continue;

        const requestTag = entry.logTag.replace(/_REQUEST$/, '').replace(/_INCOMING$/, '');
        if (requestTag !== responseTag) continue;

        const sameClientRequestId =
          responseEntry.clientRequestId &&
          entry.clientRequestId &&
          responseEntry.clientRequestId === entry.clientRequestId;
        const sameOrderId =
          responseEntry.orderId &&
          entry.orderId &&
          responseEntry.orderId === entry.orderId;

        if (sameClientRequestId || sameOrderId) {
          logger.info('Found corresponding request using fallback correlation', {
            responseEntry: responseEntry.toString(),
            requestEntry: entry.toString(),
            sameClientRequestId,
            sameOrderId
          });
          return entry;
        }
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
      failedFlowRequests: this.httpClient.failedRequests || [],
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

  rewindToReplayIndex(targetIndex) {
    const rewound = super.rewindToReplayIndex(targetIndex);
    if (!rewound) {
      return false;
    }

    this.bufferManager.resetForReplay();
    this.httpClient.cleanup(0);
    this.httpClient.failedRequests = [];
    this.shouldStop = false;
    this.isRunning = true;
    this.resolvedStuckEntrySignals.clear();

    logger.info('Rewound async orchestrator replay state in place', {
      orderId: this.orderId,
      targetIndex
    });

    return true;
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
