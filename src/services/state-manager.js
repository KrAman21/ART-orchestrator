import { logger } from '../utils/logger.js';

const IDENTIFIER_TYPE_ALIASES = Object.freeze({
  loanApplicationId: ['loanApplicationId', 'loan_application_id', 'partnerRefNo', 'applicationid', 'ApplicationId', 'applicationId'],
  txnRefId: ['txnRefId', 'txnrefid', 'txn_ref_id', '_txnrefid', 'TxnRefId', 'TxnRefID'],
  customerId: ['customerId', 'customer_id', 'customerid', 'merchant_customer_id', 'merchantCustomerId'],
  lineDetailId: ['lineDetailId', 'lineId'],
  merchantUserId: ['merchantUserId'],
  lineDetailExtensibleDataId: ['lineDetailExtensibleDataId'],
  referenceId: ['referenceId'],
  actionRequiredId: ['actionId']
});

const LOG_TAG_IDENTIFIER_TYPE_OVERRIDES = Object.freeze({
  'POLLING API :: LINE_STATUS_REQUEST': {
    applicationid: 'lineDetailId',
    ApplicationId: 'lineDetailId'
  },
  'POLLING API :: LINE_STATUS_RESPONSE': {
    applicationid: 'lineDetailId',
    ApplicationId: 'lineDetailId'
  },
  'CREATE APPLICATION API_REQUEST': {
    applicationid: 'lineDetailId',
    ApplicationId: 'lineDetailId'
  },
  'CREATE APPLICATION API_RESPONSE': {
    applicationid: 'lineDetailId',
    ApplicationId: 'lineDetailId'
  },
  DMI_WEBHOOK_REQUEST: {
    applicationid: 'lineDetailId',
    ApplicationId: 'lineDetailId'
  },
  'KYC SERVICE API_REQUEST': {
    applicationid: 'lineDetailId',
    ApplicationId: 'lineDetailId'
  },
  'KYC SERVICE API_RESPONSE': {
    applicationid: 'lineDetailId',
    ApplicationId: 'lineDetailId'
  },
  'KFS SERVICE API :: PARENT_REQUEST': {
    applicationid: 'lineDetailId',
    ApplicationId: 'lineDetailId'
  },
  'KFS SERVICE API :: PARENT_RESPONSE': {
    applicationid: 'lineDetailId',
    ApplicationId: 'lineDetailId'
  },
  'KFS SERVICE API :: CHILD_REQUEST': {
    applicationid: 'lineDetailId',
    ApplicationId: 'lineDetailId'
  },
  'KFS SERVICE API :: CHILD_RESPONSE': {
    applicationid: 'lineDetailId',
    ApplicationId: 'lineDetailId'
  },
  UpdateKYCRequest_REQUEST: {
    id: 'actionRequiredId'
  },
  'HDB_APPLICATION_STATUS_API :: FETCH_OFFER_REQUEST': {
    applicationId: null,
    applicationid: null,
    ApplicationId: null
  },
  'HDB_APPLICATION_STATUS_API :: FETCH_OFFER_RESPONSE': {
    applicationId: null,
    applicationid: null,
    ApplicationId: null
  },
  HDB_CHECK_OFFERS_API_REQUEST: {
    applicationId: null,
    applicationid: null,
    ApplicationId: null
  },
  HDB_CHECK_OFFERS_API_RESPONSE: {
    applicationId: null,
    applicationid: null,
    ApplicationId: null
  },
  HDB_WEBHOOK_REQUEST: {
    loanApplicationId: null,
    loan_application_id: null,
    applicationId: null,
    applicationid: null,
    ApplicationId: null,
    partnerRefNo: null
  },
  HDB_WEBHOOK_RESPONSE: {
    loanApplicationId: null,
    loan_application_id: null,
    applicationId: null,
    applicationid: null,
    ApplicationId: null,
    partnerRefNo: null
  }
});

const LOAN_APPLICATION_ID_MAPPING_SUPPRESSION_LOG_TAGS = new Set([
  'HDB_APPLICATION_STATUS_API :: FETCH_OFFER_REQUEST',
  'HDB_APPLICATION_STATUS_API :: FETCH_OFFER_RESPONSE',
  'HDB_CHECK_OFFERS_API_REQUEST',
  'HDB_CHECK_OFFERS_API_RESPONSE',
  'HDB_WEBHOOK_REQUEST',
  'HDB_WEBHOOK_RESPONSE'
]);

const NORMALIZED_IDENTIFIER_ALIAS_TO_TYPE = new Map(
  Object.entries(IDENTIFIER_TYPE_ALIASES).flatMap(([type, aliases]) =>
    aliases.map(alias => [alias.toLowerCase(), type])
  )
);

const PROD_LOAN_APPLICATION_ID_KEYS = new Set([
  'loan_application_id',
  'loanapplicationid'
]);

const PROD_SESSION_TOKEN_KEYS = new Set([
  'sessiontoken',
  'session_token',
  'x-session-token'
]);

const PROD_TXN_REF_ID_KEYS = new Set([
  'txnrefid',
  'txn_ref_id',
  '_txnrefid'
]);

const PROD_CUSTOMER_ID_KEYS = new Set([
  'customerid',
  'customer_id',
  'merchant_customer_id',
  'merchantcustomerid'
]);

/**
 * PendingRequest represents an in-flight request waiting for response
 */
class PendingRequest {
  constructor(correlationId, expectedLogEntry, timeoutMs = 10000) {
    this.correlationId = correlationId;
    this.expectedLogEntry = expectedLogEntry;
    this.createdAt = Date.now();
    this.timeoutMs = timeoutMs;
    this.resolve = null;
    this.reject = null;
    this.timedOut = false;
    this.settled = false;

    // Create promise that can be resolved externally.
    this.promise = new Promise((resolve, reject) => {
      this.resolve = resolve;
      this.reject = reject;
    });

    // Mark the promise as handled immediately so timeout rejections do not crash
    // Node before the caller gets a chance to await the result.
    this.promise.catch(() => {});

    // Set up timeout.
    this.timeoutHandle = setTimeout(() => {
      if (this.settled) {
        return;
      }
      this.timedOut = true;
      this.fail(new Error(
        `Request ${correlationId} timed out after ${timeoutMs}ms. ` +
        `Expected response for: ${expectedLogEntry?.message?.log_tag}`
      ));
    }, timeoutMs);
  }

  complete(response) {
    if (this.settled) return false;
    this.settled = true;
    clearTimeout(this.timeoutHandle);
    this.resolve(response);
    return true;
  }

  fail(error) {
    if (this.settled) return false;
    this.settled = true;
    clearTimeout(this.timeoutHandle);
    this.reject(error);
    return true;
  }
}

/**
 * StateManager handles:
 * - Pending requests waiting for responses
 * - Early responses that arrive before their turn in the log sequence
 * - Correlation tracking between requests and responses
 */
export class StateManager {
  constructor(config = {}) {
    // Map<correlationId, PendingRequest>
    this.pendingRequests = new Map();

    // Map<correlationId, responseData> - responses that arrived early
    this.pendingResponses = new Map();

    // Map<requestKey, requestData> - requests received but not yet processed
    // requestKey format: "source_destination|api|correlationId"
    this._bufferedRequests = new Map();

    // Map to store response headers per correlation key
    this.responseHeaders = new Map();
    this.forwardedForByContext = new Map();

    // Maps recorded IDs to the local IDs created during replay
    this.identifierMappings = new Map(
      Object.keys(IDENTIFIER_TYPE_ALIASES).map(type => [type, new Map()])
    );
    this.loanApplicationIdMappings = this.identifierMappings.get('loanApplicationId');
    this.prodLoanApplicationIds = new Set();
    this.replayLoanApplicationIdAliases = new Set();
    this.currentReplayLoanApplicationId = null;
    this.prodSessionTokens = new Set();
    this.replaySessionTokenAliases = new Set();
    this.currentReplaySessionToken = null;
    this.prodTxnRefIds = new Set();
    this.replayTxnRefIdAliases = new Set();
    this.currentReplayTxnRefId = null;
    this.prodCustomerIds = new Set();
    this.replayCustomerIdAliases = new Set();
    this.currentReplayCustomerId = null;
    this.replayAppAuthByLoanApplicationId = new Map();

    this.config = {
      defaultTimeoutMs: 10000,
      maxBufferedResponses: 100,
      maxBufferedRequests: 100,
      ...config
    };
  }

  /**
   * Register a new pending request that we're expecting a response for
   * @param {string} correlationId - Unique identifier for this request-response pair
   * @param {Object} expectedLogEntry - The expected log entry from the sequence
   * @returns {Promise} - Resolves when response is received
   */
  registerPendingRequest(correlationId, expectedLogEntry) {
    // Check if response already arrived early
    if (this.pendingResponses.has(correlationId)) {
      const earlyResponse = this.pendingResponses.get(correlationId);
      this.pendingResponses.delete(correlationId);
      logger.debug('Using early-arrived response', { correlationId });
      return Promise.resolve(earlyResponse);
    }

    // Create new pending request
    const pending = new PendingRequest(
      correlationId,
      expectedLogEntry,
      this.config.defaultTimeoutMs
    );

    this.pendingRequests.set(correlationId, pending);
    logger.debug('Registered pending request', {
      correlationId,
      pendingCount: this.pendingRequests.size
    });

    pending.promise.then(
      () => this.cleanupPendingRequest(correlationId, pending),
      () => this.cleanupPendingRequest(correlationId, pending)
    );

    return pending.promise;
  }

  cleanupPendingRequest(correlationId, pending) {
    const activePending = this.pendingRequests.get(correlationId);
    if (activePending === pending) {
      this.pendingRequests.delete(correlationId);
      logger.debug('Cleaned up settled pending request', {
        correlationId,
        pendingCount: this.pendingRequests.size
      });
    }
  }

  /**
   * Handle an incoming response - either match with pending request or buffer
   * @param {string} correlationId - The correlation ID
   * @param {Object} responseData - The response payload
   * @returns {boolean} - True if matched with pending request, false if buffered
   */
  handleIncomingResponse(correlationId, responseData) {
    // Check if we have a pending request waiting
    const pending = this.pendingRequests.get(correlationId);
    if (pending) {
      const completed = pending.complete(responseData);
      this.pendingRequests.delete(correlationId);
      logger.debug('Response matched with pending request', {
        correlationId,
        completed
      });
      return true;
    }

    // Buffer for later (early response)
    if (this.pendingResponses.size >= this.config.maxBufferedResponses) {
      logger.warn('Pending responses buffer full, dropping oldest');
      const firstKey = this.pendingResponses.keys().next().value;
      this.pendingResponses.delete(firstKey);
    }

    this.pendingResponses.set(correlationId, responseData);
    logger.debug('Buffered early response', {
      correlationId,
      bufferedCount: this.pendingResponses.size
    });
    return false;
  }

  /**
   * Buffer an incoming request that arrived before its turn in log sequence
   * @param {string} requestKey - Unique key for this request
   * @param {Object} requestData - The request payload and metadata
   */
  bufferIncomingRequest(requestKey, requestData) {
    if (this._bufferedRequests.size >= this.config.maxBufferedRequests) {
      logger.warn('Buffered requests buffer full, dropping oldest');
      const firstKey = this._bufferedRequests.keys().next().value;
      this._bufferedRequests.delete(firstKey);
    }

    this._bufferedRequests.set(requestKey, {
      data: requestData,
      receivedAt: Date.now()
    });

    logger.debug('Buffered early request', {
      requestKey,
      bufferedCount: this._bufferedRequests.size
    });
  }

  /**
   * Retrieve a buffered request if present
   * @param {string} requestKey - The key to look up
   * @returns {Object|null} - The buffered request data or null
   */
  retrieveBufferedRequest(requestKey) {
    const buffered = this._bufferedRequests.get(requestKey);
    if (buffered) {
      this._bufferedRequests.delete(requestKey);
      logger.debug('Retrieved buffered request', { requestKey });
      return buffered.data;
    }
    return null;
  }

  /**
   * Check if a request is already buffered
   * @param {string} requestKey - The key to check
   * @returns {boolean}
   */
  hasBufferedRequest(requestKey) {
    return this._bufferedRequests.has(requestKey);
  }

  /**
   * Find a buffered request matching the expected entry criteria
   * @param {Object} criteria - { source, destination, logTag }
   * @returns {Object|null} - { key, data } or null if not found
   */
  findBufferedRequest(criteria) {
    for (const [key, entry] of this._bufferedRequests.entries()) {
      const data = entry.data;
      if (
        data.source === criteria.source &&
        data.destination === criteria.destination &&
        data.logTag === criteria.logTag
      ) {
        // For async parallel calls, also check lenderOrgId if provided
        if (criteria.lenderOrgId && data.lenderOrgId) {
          if (data.lenderOrgId !== criteria.lenderOrgId) {
            continue;
          }
        }
        return { key, data };
      }
    }
    return null;
  }

  /**
   * Remove a buffered request by key
   * @param {string} requestKey - The key to remove
   */
  removeBufferedRequest(requestKey) {
    const existed = this._bufferedRequests.delete(requestKey);
    if (existed) {
      logger.debug('Removed buffered request', { requestKey });
    }
    return existed;
  }

  /**
   * Find a buffered request by lenderOrgId
   * @param {string} lenderOrgId - The lender org ID to match
   * @returns {Object|null} - { key, data } or null
   */
  findBufferedRequestByLenderOrgId(lenderOrgId) {
    for (const [key, entry] of this._bufferedRequests.entries()) {
      const data = entry.data;
      if (data.lenderOrgId === lenderOrgId) {
        return { key, data };
      }
    }
    return null;
  }

  getTrackedIdentifierTypes() {
    return Object.keys(IDENTIFIER_TYPE_ALIASES);
  }

  resetProdLoanApplicationIds() {
    this.prodLoanApplicationIds.clear();
    this.replayLoanApplicationIdAliases.clear();
    this.currentReplayLoanApplicationId = null;
  }

  resetProdSessionTokens() {
    this.prodSessionTokens.clear();
    this.replaySessionTokenAliases.clear();
    this.currentReplaySessionToken = null;
  }

  resetProdTxnRefIds() {
    this.prodTxnRefIds.clear();
    this.replayTxnRefIdAliases.clear();
    this.currentReplayTxnRefId = null;
  }

  resetProdCustomerIds() {
    this.prodCustomerIds.clear();
    this.replayCustomerIdAliases.clear();
    this.currentReplayCustomerId = null;
  }

  extractProdLoanApplicationIdsFromValue(source) {
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
          typeof nestedValue === 'string' &&
          PROD_LOAN_APPLICATION_ID_KEYS.has(String(key).toLowerCase()) &&
          !seen.has(nestedValue)
        ) {
          seen.add(nestedValue);
          ids.push(nestedValue);
        }

        visit(nestedValue);
      }
    };

    visit(source);
    return ids;
  }

  seedProdLoanApplicationIdsFromLogs(logs = []) {
    this.resetProdLoanApplicationIds();

    const discoveredIds = this.extractProdLoanApplicationIdsFromValue(logs);
    for (const loanApplicationId of discoveredIds) {
      this.prodLoanApplicationIds.add(loanApplicationId);
    }

    logger.info('Seeded PROD loanApplicationIds for replay', {
      total: this.prodLoanApplicationIds.size,
      loanApplicationIds: Array.from(this.prodLoanApplicationIds)
    });

    return this.prodLoanApplicationIds.size;
  }

  extractProdSessionTokensFromValue(source) {
    const tokens = [];
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
          typeof nestedValue === 'string' &&
          PROD_SESSION_TOKEN_KEYS.has(String(key).toLowerCase()) &&
          !seen.has(nestedValue)
        ) {
          seen.add(nestedValue);
          tokens.push(nestedValue);
        }

        visit(nestedValue);
      }
    };

    visit(source);
    return tokens;
  }

  seedProdSessionTokensFromLogs(logs = []) {
    this.resetProdSessionTokens();

    const discoveredTokens = this.extractProdSessionTokensFromValue(logs);
    for (const sessionToken of discoveredTokens) {
      this.prodSessionTokens.add(sessionToken);
    }

    logger.info('Seeded PROD session tokens for replay', {
      total: this.prodSessionTokens.size,
      sessionTokens: Array.from(this.prodSessionTokens)
    });

    return this.prodSessionTokens.size;
  }

  extractProdTxnRefIdsFromValue(source) {
    const txnRefIds = [];
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
          typeof nestedValue === 'string' &&
          PROD_TXN_REF_ID_KEYS.has(String(key).toLowerCase()) &&
          !seen.has(nestedValue)
        ) {
          seen.add(nestedValue);
          txnRefIds.push(nestedValue);
        }

        visit(nestedValue);
      }
    };

    visit(source);
    return txnRefIds;
  }

  seedProdTxnRefIdsFromLogs(logs = []) {
    this.resetProdTxnRefIds();

    const discoveredTxnRefIds = this.extractProdTxnRefIdsFromValue(logs);
    for (const txnRefId of discoveredTxnRefIds) {
      this.prodTxnRefIds.add(txnRefId);
    }

    logger.info('Seeded PROD txnRefIds for replay', {
      total: this.prodTxnRefIds.size,
      txnRefIds: Array.from(this.prodTxnRefIds)
    });

    return this.prodTxnRefIds.size;
  }

  extractProdCustomerIdsFromValue(source) {
    const customerIds = [];
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
          typeof nestedValue === 'string' &&
          PROD_CUSTOMER_ID_KEYS.has(String(key).toLowerCase()) &&
          !seen.has(nestedValue)
        ) {
          seen.add(nestedValue);
          customerIds.push(nestedValue);
        }

        visit(nestedValue);
      }
    };

    visit(source);
    return customerIds;
  }

  seedProdCustomerIdsFromLogs(logs = []) {
    this.resetProdCustomerIds();

    const discoveredCustomerIds = this.extractProdCustomerIdsFromValue(logs);
    for (const customerId of discoveredCustomerIds) {
      this.prodCustomerIds.add(customerId);
    }

    logger.info('Seeded PROD customerIds for replay', {
      total: this.prodCustomerIds.size,
      customerIds: Array.from(this.prodCustomerIds)
    });

    return this.prodCustomerIds.size;
  }

  getProdLoanApplicationIds() {
    return Array.from(this.prodLoanApplicationIds);
  }

  getCurrentReplayLoanApplicationId() {
    return this.currentReplayLoanApplicationId;
  }

  getCurrentReplaySessionToken() {
    return this.currentReplaySessionToken;
  }

  getCurrentReplayTxnRefId() {
    return this.currentReplayTxnRefId;
  }

  getCurrentReplayCustomerId() {
    return this.currentReplayCustomerId;
  }

  setCurrentReplayLoanApplicationId(loanApplicationId, context = {}) {
    if (!loanApplicationId || typeof loanApplicationId !== 'string') {
      return false;
    }

    const previousCurrentLoanApplicationId = this.currentReplayLoanApplicationId;
    if (previousCurrentLoanApplicationId === loanApplicationId) {
      return false;
    }

    if (previousCurrentLoanApplicationId) {
      this.replayLoanApplicationIdAliases.add(previousCurrentLoanApplicationId);
    }

    this.currentReplayLoanApplicationId = loanApplicationId;

    for (const prodLoanApplicationId of this.prodLoanApplicationIds) {
      this.registerIdentifierMapping(
        'loanApplicationId',
        prodLoanApplicationId,
        loanApplicationId,
        { ...context, logTag: context?.logTag || 'GLOBAL_LAID_REPLAY_MAPPING' }
      );
    }

    logger.info('Updated current replay loanApplicationId', {
      previousLoanApplicationId: previousCurrentLoanApplicationId,
      currentLoanApplicationId: loanApplicationId,
      prodLoanApplicationIdCount: this.prodLoanApplicationIds.size,
      replayAliasCount: this.replayLoanApplicationIdAliases.size,
      sourceDestination: context?.sourceDestination || null,
      logTag: context?.logTag || null,
      requestId: context?.requestId || null
    });

    return true;
  }

  setCurrentReplaySessionToken(sessionToken, context = {}) {
    if (!sessionToken || typeof sessionToken !== 'string') {
      return false;
    }

    const previousCurrentSessionToken = this.currentReplaySessionToken;
    if (previousCurrentSessionToken === sessionToken) {
      return false;
    }

    if (previousCurrentSessionToken) {
      this.replaySessionTokenAliases.add(previousCurrentSessionToken);
    }

    this.currentReplaySessionToken = sessionToken;

    for (const prodSessionToken of this.prodSessionTokens) {
      this.replaySessionTokenAliases.add(prodSessionToken);
    }

    logger.info('Updated current replay session token', {
      previousSessionToken: previousCurrentSessionToken,
      currentSessionToken: sessionToken,
      prodSessionTokenCount: this.prodSessionTokens.size,
      replayAliasCount: this.replaySessionTokenAliases.size,
      sourceDestination: context?.sourceDestination || null,
      logTag: context?.logTag || null,
      requestId: context?.requestId || null
    });

    return true;
  }

  setCurrentReplayTxnRefId(txnRefId, context = {}) {
    if (!txnRefId || typeof txnRefId !== 'string') {
      return false;
    }

    const previousCurrentTxnRefId = this.currentReplayTxnRefId;
    if (previousCurrentTxnRefId === txnRefId) {
      return false;
    }

    if (previousCurrentTxnRefId) {
      this.replayTxnRefIdAliases.add(previousCurrentTxnRefId);
    }

    this.currentReplayTxnRefId = txnRefId;

    for (const prodTxnRefId of this.prodTxnRefIds) {
      this.replayTxnRefIdAliases.add(prodTxnRefId);
      this.registerIdentifierMapping(
        'txnRefId',
        prodTxnRefId,
        txnRefId,
        { ...context, logTag: context?.logTag || 'GLOBAL_TXN_REF_ID_REPLAY_MAPPING' }
      );
    }

    logger.info('Updated current replay txnRefId', {
      previousTxnRefId: previousCurrentTxnRefId,
      currentTxnRefId: txnRefId,
      prodTxnRefIdCount: this.prodTxnRefIds.size,
      replayAliasCount: this.replayTxnRefIdAliases.size,
      sourceDestination: context?.sourceDestination || null,
      logTag: context?.logTag || null,
      requestId: context?.requestId || null
    });

    return true;
  }

  setCurrentReplayCustomerId(customerId, context = {}) {
    if (!customerId || typeof customerId !== 'string') {
      return false;
    }

    const previousCurrentCustomerId = this.currentReplayCustomerId;
    if (previousCurrentCustomerId === customerId) {
      return false;
    }

    if (previousCurrentCustomerId) {
      this.replayCustomerIdAliases.add(previousCurrentCustomerId);
    }

    this.currentReplayCustomerId = customerId;

    for (const prodCustomerId of this.prodCustomerIds) {
      this.replayCustomerIdAliases.add(prodCustomerId);
      this.registerIdentifierMapping(
        'customerId',
        prodCustomerId,
        customerId,
        { ...context, logTag: context?.logTag || 'GLOBAL_CUSTOMER_ID_REPLAY_MAPPING' }
      );
    }

    logger.info('Updated current replay customerId', {
      previousCustomerId: previousCurrentCustomerId,
      currentCustomerId: customerId,
      prodCustomerIdCount: this.prodCustomerIds.size,
      replayAliasCount: this.replayCustomerIdAliases.size,
      sourceDestination: context?.sourceDestination || null,
      logTag: context?.logTag || null,
      requestId: context?.requestId || null
    });

    return true;
  }

  shouldRewriteOutgoingLoanApplicationId(value) {
    if (!value || typeof value !== 'string') {
      return false;
    }

    if (this.currentReplayLoanApplicationId && value === this.currentReplayLoanApplicationId) {
      return false;
    }

    return this.prodLoanApplicationIds.has(value) || this.replayLoanApplicationIdAliases.has(value);
  }

  shouldRewriteOutgoingSessionToken(value) {
    if (!value || typeof value !== 'string') {
      return false;
    }

    if (this.currentReplaySessionToken && value === this.currentReplaySessionToken) {
      return false;
    }

    return this.prodSessionTokens.has(value) || this.replaySessionTokenAliases.has(value);
  }

  shouldRewriteOutgoingTxnRefId(value) {
    if (!value || typeof value !== 'string') {
      return false;
    }

    if (this.currentReplayTxnRefId && value === this.currentReplayTxnRefId) {
      return false;
    }

    return this.prodTxnRefIds.has(value) || this.replayTxnRefIdAliases.has(value);
  }

  shouldRewriteOutgoingCustomerId(value) {
    if (!value || typeof value !== 'string') {
      return false;
    }

    if (this.currentReplayCustomerId && value === this.currentReplayCustomerId) {
      return false;
    }

    return this.prodCustomerIds.has(value) || this.replayCustomerIdAliases.has(value);
  }

  rewriteOutgoingLoanApplicationIds(value, context = {}) {
    if (!this.currentReplayLoanApplicationId && !this.currentReplaySessionToken && !this.currentReplayTxnRefId && !this.currentReplayCustomerId) {
      return value;
    }

    if (typeof value === 'string') {
      if (this.currentReplaySessionToken && this.shouldRewriteOutgoingSessionToken(value)) {
        logger.debug('Rewriting outgoing session token value', {
          originalValue: value,
          rewrittenValue: this.currentReplaySessionToken,
          logTag: context?.logTag || null,
          field: context?.field || null
        });
        return this.currentReplaySessionToken;
      }

      if (this.currentReplayTxnRefId && this.shouldRewriteOutgoingTxnRefId(value)) {
        logger.debug('Rewriting outgoing txnRefId value', {
          originalValue: value,
          rewrittenValue: this.currentReplayTxnRefId,
          logTag: context?.logTag || null,
          field: context?.field || null
        });
        return this.currentReplayTxnRefId;
      }

      if (this.currentReplayCustomerId && this.shouldRewriteOutgoingCustomerId(value)) {
        logger.debug('Rewriting outgoing customerId value', {
          originalValue: value,
          rewrittenValue: this.currentReplayCustomerId,
          logTag: context?.logTag || null,
          field: context?.field || null
        });
        return this.currentReplayCustomerId;
      }

      if (this.shouldRewriteOutgoingLoanApplicationId(value)) {
        logger.debug('Rewriting outgoing loanApplicationId value', {
          originalValue: value,
          rewrittenValue: this.currentReplayLoanApplicationId,
          logTag: context?.logTag || null,
          field: context?.field || null
        });
        return this.currentReplayLoanApplicationId;
      }

      return value;
    }

    if (Array.isArray(value)) {
      return value.map(item => this.rewriteOutgoingLoanApplicationIds(item, context));
    }

    if (value && typeof value === 'object') {
      const rewritten = {};
      for (const [key, nestedValue] of Object.entries(value)) {
        rewritten[key] = this.rewriteOutgoingLoanApplicationIds(nestedValue, {
          ...context,
          field: key
        });
      }
      return rewritten;
    }

    return value;
  }

  rewriteOutgoingLoanApplicationIdsInEndpoint(endpoint, context = {}) {
    if ((!this.currentReplayLoanApplicationId && !this.currentReplaySessionToken && !this.currentReplayTxnRefId && !this.currentReplayCustomerId) || typeof endpoint !== 'string' || endpoint.length === 0) {
      return endpoint;
    }

    const [pathPart, queryPart] = endpoint.split('?');
    const rewrittenPath = pathPart
      .split('/')
      .map(segment => {
        if (this.currentReplaySessionToken && this.shouldRewriteOutgoingSessionToken(segment)) {
          return this.currentReplaySessionToken;
        }
        if (this.currentReplayTxnRefId && this.shouldRewriteOutgoingTxnRefId(segment)) {
          return this.currentReplayTxnRefId;
        }
        if (this.currentReplayCustomerId && this.shouldRewriteOutgoingCustomerId(segment)) {
          return this.currentReplayCustomerId;
        }
        if (this.shouldRewriteOutgoingLoanApplicationId(segment)) {
          return this.currentReplayLoanApplicationId;
        }
        return segment;
      })
      .join('/');

    if (!queryPart) {
      return rewrittenPath;
    }

    const params = new URLSearchParams(queryPart);
    for (const [key, value] of params.entries()) {
      if (this.currentReplaySessionToken && this.shouldRewriteOutgoingSessionToken(value)) {
        params.set(key, this.currentReplaySessionToken);
      } else if (this.currentReplayTxnRefId && this.shouldRewriteOutgoingTxnRefId(value)) {
        params.set(key, this.currentReplayTxnRefId);
      } else if (this.currentReplayCustomerId && this.shouldRewriteOutgoingCustomerId(value)) {
        params.set(key, this.currentReplayCustomerId);
      } else if (this.shouldRewriteOutgoingLoanApplicationId(value)) {
        params.set(key, this.currentReplayLoanApplicationId);
      }
    }

    const rewrittenEndpoint = `${rewrittenPath}?${params.toString()}`;
    if (rewrittenEndpoint !== endpoint) {
      logger.debug('Rewrote outgoing endpoint loanApplicationId values', {
        originalEndpoint: endpoint,
        rewrittenEndpoint,
        logTag: context?.logTag || null
      });
    }

    return rewrittenEndpoint;
  }

  normalizeReplayResponseEnvelope(responseData) {
    let normalized = responseData;

    for (let depth = 0; depth < 3; depth += 1) {
      if (typeof normalized !== 'string') {
        break;
      }

      try {
        normalized = JSON.parse(normalized);
      } catch {
        break;
      }
    }

    return normalized;
  }

  updateReplayAppAuthFromResponse(loanApplicationId, responseData, context = {}) {
    if (!loanApplicationId || !responseData) {
      return false;
    }

    const normalized = this.normalizeReplayResponseEnvelope(responseData);
    const payload = normalized?.payload && typeof normalized.payload === 'object'
      ? normalized.payload
      : normalized;

    if (!payload || typeof payload !== 'object') {
      return false;
    }

    const sessionToken =
      payload.sessionToken ||
      payload.session_token ||
      payload.data?.sessionToken ||
      payload.data?.session_token ||
      null;
    const userId =
      payload.userId ||
      payload.user_id ||
      payload.data?.userId ||
      payload.data?.user_id ||
      null;
    const deviceTokenId =
      payload.deviceTokenId ||
      payload.device_token_id ||
      payload.data?.deviceTokenId ||
      payload.data?.device_token_id ||
      null;

    if (!sessionToken && !userId && !deviceTokenId) {
      return false;
    }

    if (sessionToken) {
      this.setCurrentReplaySessionToken(sessionToken, context);
    }

    this.replayAppAuthByLoanApplicationId.set(loanApplicationId, {
      sessionToken,
      userId,
      deviceTokenId,
      updatedAt: Date.now(),
      logTag: context?.logTag || null
    });

    logger.info('Updated live replay app auth from response', {
      loanApplicationId,
      logTag: context?.logTag || null,
      hasSessionToken: Boolean(sessionToken),
      hasUserId: Boolean(userId),
      hasDeviceTokenId: Boolean(deviceTokenId)
    });

    return true;
  }

  getReplayAppAuth(loanApplicationId) {
    if (!loanApplicationId) {
      return null;
    }

    return this.replayAppAuthByLoanApplicationId.get(loanApplicationId) || null;
  }

  getIdentifierTypeForKey(key) {
    if (typeof key !== 'string') {
      return null;
    }

    return NORMALIZED_IDENTIFIER_ALIAS_TO_TYPE.get(key.toLowerCase()) || null;
  }

  getIdentifierTypeForKeyInContext(key, context = {}) {
    if (typeof key !== 'string') {
      return null;
    }

    const logTag = typeof context?.logTag === 'string' ? context.logTag : null;
    if (logTag) {
      const logTagOverrides = LOG_TAG_IDENTIFIER_TYPE_OVERRIDES[logTag];
      if (logTagOverrides && Object.prototype.hasOwnProperty.call(logTagOverrides, key)) {
        return logTagOverrides[key];
      }
    }

    return this.getIdentifierTypeForKey(key);
  }

  shouldSuppressIdentifierMapping(identifierType, context = {}) {
    const logTag = typeof context?.logTag === 'string' ? context.logTag : null;

    return (
      identifierType === 'loanApplicationId' &&
      logTag &&
      LOAN_APPLICATION_ID_MAPPING_SUPPRESSION_LOG_TAGS.has(logTag)
    );
  }

  registerIdentifierMapping(identifierType, originalValue, localValue, context = {}) {
    if (!identifierType || !originalValue || !localValue) return false;
    if (originalValue === localValue) return false;

    const mappings = this.identifierMappings.get(identifierType);
    if (!mappings) {
      return false;
    }

    if (this.shouldSuppressIdentifierMapping(identifierType, context)) {
      logger.info('Suppressed identifier mapping for non-canonical lender-scoped field', {
        identifierType,
        originalValue,
        localValue,
        logTag: context?.logTag || null
      });
      return false;
    }

    const existing = mappings.get(originalValue);
    if (existing === localValue) {
      return false;
    }

    mappings.set(originalValue, localValue);
    logger.info('Registered identifier mapping', {
      identifierType,
      originalValue,
      localValue
    });
    return true;
  }

  registerLoanApplicationIdMapping(originalLoanApplicationId, localLoanApplicationId) {
    return this.registerIdentifierMapping(
      'loanApplicationId',
      originalLoanApplicationId,
      localLoanApplicationId
    );
  }

  getMappedLoanApplicationId(loanApplicationId) {
    return this.getMappedIdentifier('loanApplicationId', loanApplicationId);
  }

  getMappedIdentifier(identifierType, value) {
    if (!identifierType || !value) return value;
    const mappings = this.identifierMappings.get(identifierType);
    if (!mappings) {
      return value;
    }
    return mappings.get(value) || value;
  }

  collectIdentifiersByType(source, identifierType, context = {}) {
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
          this.getIdentifierTypeForKeyInContext(key, context) === identifierType &&
          typeof nestedValue === 'string' &&
          !seen.has(nestedValue)
        ) {
          seen.add(nestedValue);
          ids.push(nestedValue);
          continue;
        }

        visit(nestedValue);
      }
    };

    visit(source);
    return ids;
  }

  registerMappingsFromPayloadPair(expectedPayload, actualPayload, context = {}) {
    if (!expectedPayload || !actualPayload) {
      return 0;
    }

    let totalRegistered = 0;

    for (const identifierType of this.getTrackedIdentifierTypes()) {
      const expectedIds = this.collectIdentifiersByType(expectedPayload, identifierType, context);
      const actualIds = this.collectIdentifiersByType(actualPayload, identifierType, context);

      for (let index = 0; index < Math.min(expectedIds.length, actualIds.length); index += 1) {
        if (this.registerIdentifierMapping(identifierType, expectedIds[index], actualIds[index], context)) {
          totalRegistered += 1;
        }
      }
    }

    if (totalRegistered > 0) {
      logger.info('Registered identifier mappings from payload pair', {
        logTag: context?.logTag || null,
        totalRegistered
      });
    }

    return totalRegistered;
  }

  remapReplayValue(value, keyHint = null, context = {}) {
    if (typeof value === 'string') {
      const identifierType = this.getIdentifierTypeForKeyInContext(keyHint, context);
      if (identifierType) {
        return this.getMappedIdentifier(identifierType, value);
      }

      return this.getMappedLoanApplicationId(value);
    }

    if (Array.isArray(value)) {
      return value.map(item => this.remapReplayValue(item, keyHint, context));
    }

    if (value && typeof value === 'object') {
      const remapped = {};
      for (const [key, nestedValue] of Object.entries(value)) {
        remapped[key] = this.remapReplayValue(nestedValue, key, context);
      }
      return remapped;
    }

    return value;
  }

  getLoanApplicationIdMappings() {
    return Object.fromEntries(this.loanApplicationIdMappings.entries());
  }

  getIdentifierMappings() {
    return Object.fromEntries(
      Array.from(this.identifierMappings.entries()).map(([identifierType, mappings]) => [
        identifierType,
        Object.fromEntries(mappings.entries())
      ])
    );
  }

  buildReplayContextKeys(context = {}) {
    const keys = [];
    const loanApplicationId = context.loanApplicationId || context.payload?.loanApplicationId || context.payload?.loan_application_id;
    const orderId = context.orderId || context.headers?.['x-order-id'] || context.headers?.['X-Order-Id'];
    const requestId = context.requestId || context.headers?.['x-request-id'] || context.headers?.['X-Request-Id'];

    if (loanApplicationId) {
      keys.push(`loanApplicationId:${loanApplicationId}`);
    }
    if (orderId) {
      keys.push(`orderId:${orderId}`);
    }
    if (requestId) {
      keys.push(`requestId:${requestId}`);
    }

    return keys;
  }

  recordForwardedFor(context = {}) {
    const headers = context.headers || {};
    const forwardedFor =
      headers['x-forwarded-for'] ||
      headers['X-Forwarded-For'] ||
      headers['x_forwarded_for'];

    if (!forwardedFor) {
      return false;
    }

    const keys = this.buildReplayContextKeys(context);
    if (keys.length === 0) {
      return false;
    }

    for (const key of keys) {
      this.forwardedForByContext.set(key, forwardedFor);
    }

    logger.info('Recorded x-forwarded-for for replay context', {
      keys,
      forwardedFor
    });
    return true;
  }

  resolveForwardedFor(context = {}) {
    const keys = this.buildReplayContextKeys(context);
    for (const key of keys) {
      const forwardedFor = this.forwardedForByContext.get(key);
      if (forwardedFor) {
        return forwardedFor;
      }
    }

    return null;
  }

  /**
   * Store response headers for a correlation key
   * @param {string} correlationKey - The correlation key
   * @param {Object} headers - Response headers
   */
  storeResponseHeaders(correlationKey, headers) {
    this.responseHeaders.set(correlationKey, headers);
    logger.debug('Stored response headers', { correlationKey, headerKeys: Object.keys(headers) });
  }

  /**
   * Get stored response headers for a correlation key
   * @param {string} correlationKey - The correlation key
   * @returns {Object|null} - The headers or null
   */
  getResponseHeaders(correlationKey) {
    const headers = this.responseHeaders.get(correlationKey);
    if (headers) {
      this.responseHeaders.delete(correlationKey);
      logger.debug('Retrieved response headers', { correlationKey, headerKeys: Object.keys(headers) });
    }
    return headers || null;
  }

  /**
   * Generate a correlation key for request-response pairing
   * @param {string} api - API identifier
   * @param {string} sourceDestination - Source to destination (e.g., "LSP_TO_GW")
   * @param {string} requestId - Request ID from trace
   * @returns {string}
   */
  static generateCorrelationKey(api, sourceDestination, requestId) {
    // Use requestId as primary correlation, fallback to composite key
    return requestId || `${sourceDestination}:${api}:${Date.now()}`;
  }

  /**
   * Generate a request key for buffering incoming requests
   * @param {string} source - Source service (LSP, GW)
   * @param {string} api - API endpoint/path
   * @param {string} requestId - Request ID
   * @returns {string}
   */
  static generateRequestKey(source, api, requestId) {
    return `${source}|${api}|${requestId}`;
  }

  /**
   * Clean up any stale entries
   */
  cleanup() {
    const now = Date.now();
    const maxAge = this.config.defaultTimeoutMs * 2;

    // Clean old buffered requests
    for (const [key, entry] of this._bufferedRequests.entries()) {
      if (now - entry.receivedAt > maxAge) {
        this._bufferedRequests.delete(key);
        logger.debug('Cleaned up stale buffered request', { key });
      }
    }

    // Clean old pending responses
    // Note: pending requests have their own timeout handling

    logger.info('StateManager cleanup completed', {
      pendingRequests: this.pendingRequests.size,
      pendingResponses: this.pendingResponses.size,
      bufferedRequests: this._bufferedRequests.size
    });
  }

  clearReplayTransientState() {
    for (const pending of this.pendingRequests.values()) {
      clearTimeout(pending.timeoutHandle);
    }

    this.pendingRequests.clear();
    this.pendingResponses.clear();
    this._bufferedRequests.clear();
    this.responseHeaders.clear();
    this.forwardedForByContext.clear();
    this.replayAppAuthByLoanApplicationId.clear();
    this.replaySessionTokenAliases.clear();
    this.currentReplaySessionToken = null;

    logger.info('Cleared transient replay state', {
      pendingRequests: 0,
      pendingResponses: 0,
      bufferedRequests: 0
    });
  }

  /**
   * Get current state summary
   */
  getState() {
    return {
      pendingRequests: this.pendingRequests.size,
      pendingResponses: this.pendingResponses.size,
      bufferedRequests: this._bufferedRequests.size,
      pendingRequestIds: Array.from(this.pendingRequests.keys()),
      bufferedResponseIds: Array.from(this.pendingResponses.keys())
    };
  }

  /**
   * Iterate over buffered requests
   * @yields {[string, Object]} [key, entry] pairs
   */
  *iterateBufferedRequests() {
    for (const [key, entry] of this._bufferedRequests) {
      yield [key, entry];
    }
  }
}

export default StateManager;
