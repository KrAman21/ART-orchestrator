import { isAsyncParallelApi } from '../config.js';
import { transformRequest } from '../services/request-transformer.js';
import { findCorrespondingResponseEntry, matchesRequestContext } from '../services/response-matcher.js';

function getMultiTagEndpointFamily(api, source, destination) {
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

function belongsToSameMultiTagFamily(left, right) {
  if (!left || !right) {
    return false;
  }

  if (left.source !== right.source || left.destination !== right.destination || left.api !== right.api) {
    return false;
  }

  const family = getMultiTagEndpointFamily(left.api, left.source, left.destination);
  if (!family) {
    return false;
  }

  return family.includes(left.logTag) && family.includes(right.logTag);
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

function matchesKfsOpportunityId(left, right) {
  if (!left || !right) {
    return true;
  }

  if (left.api !== '/prod/MOCK_DATA' || right.api !== '/prod/MOCK_DATA') {
    return true;
  }

  const leftOpportunityId = extractOpportunityId(left);
  const rightOpportunityId = extractOpportunityId(right);

  if (!leftOpportunityId || !rightOpportunityId) {
    return true;
  }

  return leftOpportunityId === rightOpportunityId;
}

function transformReplayPayloadForEntry(stateManager, payload, entry) {
  const remappedPayload = stateManager?.remapReplayValue
    ? stateManager.remapReplayValue(payload, null, { logTag: entry?.logTag })
    : payload;
  return transformRequest(remappedPayload, entry?.logTag);
}

function isFetchLoanApplicationDataRequest(incoming) {
  return (
    incoming?.source === 'GATEWAY' &&
    incoming?.destination === 'LSP' &&
    (
      incoming?.api === '/api/fetch/loanApplicationData' ||
      incoming?.logTag === 'FECTH_LOAN_APPLICATION_DATA_API_REQUEST' ||
      incoming?.logTag === 'FETCH_LOAN_APPLICATION_DATA_API_REQUEST'
    )
  );
}

/**
 * RetryHandler - Handles retry detection for incoming requests
 * Checks if an incoming request is a retry of a previously processed request
 * and returns the cached response payload if found.
 */
export class RetryHandler {
  /**
   * @param {Object} dependencies - Dependencies for the handler
   * @param {Object} dependencies.validator - Validator instance with entries and processedIndices
   * @param {Object} dependencies.stateManager - State manager instance
   * @param {Map} dependencies.pendingExternalRequests - Map of pending external requests
   * @param {Object} dependencies.logger - Logger instance
   */
  constructor({ validator, stateManager, pendingExternalRequests, logger }) {
    this.validator = validator;
    this.stateManager = stateManager;
    this.pendingExternalRequests = pendingExternalRequests;
    this.logger = logger;
  }

  /**
   * Handle retry request - checks if an incoming request is a retry
   * of a previously processed request and returns the cached response.
   * 
   * @param {Object} incoming - The incoming request object
   * @returns {Object|null} - Returns {success, payload, retried} if retry detected, null otherwise
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

    const currentEntry = this.validator.getCurrentEntry();

    if (isFetchLoanApplicationDataRequest(incoming)) {
      this.logger.info('Skipping generic retry short-circuit for fetchLoanApplicationData request', {
        incomingRequestId: incoming.requestId,
        incomingLogTag: incoming.logTag,
        currentEntry: currentEntry?.toString?.() || null
      });
      return null;
    }

    if (currentEntry && currentEntry.isRequest && this.validator.matchesExpected(currentEntry, incoming)) {
      this.logger.debug('Incoming request matches current replay entry, not treating as retry', {
        currentEntryIndex: currentEntry.index,
        logTag: incoming.logTag
      });
      return null;
    }

    if (
      currentEntry &&
      currentEntry.isRequest &&
      belongsToSameMultiTagFamily(currentEntry, incoming) &&
      currentEntry.logTag !== incoming.logTag
    ) {
      this.logger.info('Incoming request belongs to current multi-tag replay family sibling, not treating as retry', {
        currentEntryIndex: currentEntry.index,
        currentEntryLogTag: currentEntry.logTag,
        incomingLogTag: incoming.logTag,
        api: incoming.api
      });
      return null;
    }

    const futureMatch = this.findFutureUnprocessedMatch(incoming);
    const processedMatch = this.findProcessedMatch(incoming);
    const pendingRetryMatch = this.findPendingRetryMatch(incoming, currentEntry);

    if (pendingRetryMatch) {
      if (futureMatch) {
        this.logger.info('Treating incoming request as retry despite future replay match because matching external call is already pending', {
          futureEntryIndex: futureMatch.index,
          pendingEntryIndex: pendingRetryMatch.requestEntry.index,
          currentEntryIndex: currentEntry?.index,
          incomingLogTag: incoming.logTag,
          contextKey: pendingRetryMatch.contextKey
        });
      } else {
        this.logger.info('Detected retried request for pending external call', {
          source: incoming.source,
          destination: incoming.destination,
          api: incoming.api,
          contextKey: pendingRetryMatch.contextKey
        });
      }

      return {
        success: true,
        payload: transformReplayPayloadForEntry(this.stateManager, pendingRetryMatch.responseEntry.payload, pendingRetryMatch.responseEntry),
        retried: true
      };
    }

    if (futureMatch) {
      this.logger.info('Incoming request has future unprocessed replay match, not treating as retry', {
        futureEntryIndex: futureMatch.index,
        processedEntryIndex: processedMatch?.index ?? null,
        currentEntryIndex: currentEntry?.index,
        incomingLogTag: incoming.logTag,
        incomingLenderOrgId: incoming.lenderOrgId,
        incomingLoanApplicationId: incoming.loanApplicationId
      });
      return null;
    }

    // Also check processed indices for recently completed external calls
    // (in case the webhook arrived and cleared the pending entry)
    const processedEntries = this.validator.entries.filter(
      (_entry, index) => this.validator.processedIndices.has(index)
    );

    this.logger.debug('Checking processed entries for retry', {
      incomingSource: incoming.source,
      incomingDest: incoming.destination,
      incomingLogTag: incoming.logTag,
      incomingLenderOrgId: incoming.lenderOrgId,
      processedCount: processedEntries.length
    });

    for (const entry of processedEntries) {
      this.logger.debug('Checking entry for retry match', {
        entrySource: entry.source,
        entryDest: entry.destination,
        entryLogTag: entry.logTag,
        entryLenderOrgId: entry.lenderOrgId,
        entryIndex: entry.index,
        isAsync: isAsyncParallelApi(entry.sourceDestination, entry.logTag)
      });

      if (
        entry.isRequest &&
        entry.source === incoming.source &&
        entry.destination === incoming.destination &&
        entry.logTag === incoming.logTag
      ) {
        if (
          currentEntry &&
          currentEntry.isRequest &&
          belongsToSameMultiTagFamily(entry, currentEntry) &&
          belongsToSameMultiTagFamily(entry, incoming) &&
          currentEntry.logTag !== entry.logTag
        ) {
          this.logger.info('Skipping completed-retry match because current replay entry expects a different sibling in same endpoint family', {
            currentEntryIndex: currentEntry.index,
            currentEntryLogTag: currentEntry.logTag,
            processedEntryIndex: entry.index,
            processedEntryLogTag: entry.logTag,
            incomingLogTag: incoming.logTag,
            api: incoming.api
          });
          continue;
        }

        this.logger.debug('Entry matches source/dest/logTag');
        // Check context match
        let contextMatches = true;
        if (incoming.loanApplicationId && entry.loanApplicationId) {
          contextMatches = incoming.loanApplicationId === entry.loanApplicationId;
        }

        // For async parallel calls, lenderOrgId is the primary identifier
        // because GW reuses the same requestId for all parallel calls
        if (isAsyncParallelApi(entry.sourceDestination, entry.logTag)) {
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

        if (contextMatches && !matchesKfsOpportunityId(incoming, entry)) {
          this.logger.info('Skipping completed-retry match because KFS opportunity id differs', {
            api: incoming.api,
            incomingOpportunityId: extractOpportunityId(incoming),
            processedOpportunityId: extractOpportunityId(entry),
            processedEntryIndex: entry.index,
            processedEntryLogTag: entry.logTag
          });
          continue;
        }

        if (contextMatches) {
          // Find the corresponding response (search all entries including processed)
          const responseEntry = this.findCorrespondingResponse(entry, true);
          if (responseEntry) {
            this.logger.info('Detected retried request for completed external call', {
              source: incoming.source,
              destination: incoming.destination,
              api: incoming.api
            });

            return {
              success: true,
              payload: transformReplayPayloadForEntry(this.stateManager, responseEntry.payload, responseEntry),
              retried: true
            };
          }
        }
      }
    }

    return null; // Not a retry
  }

  /**
   * Find a processed request matching this incoming request.
   *
   * @param {Object} incoming - The incoming request
   * @returns {Object|null} - Matching processed entry or null
   */
  findProcessedMatch(incoming) {
    for (const [index, entry] of this.validator.entries.entries()) {
      if (!this.validator.processedIndices.has(index)) continue;
      if (!entry || !entry.isRequest || entry.shouldSkip()) continue;
      if (this.validator.matchesExpected(entry, incoming)) {
        return entry;
      }
    }

    return null;
  }

  findPendingRetryMatch(incoming, currentEntry = this.validator.getCurrentEntry()) {
    for (const [contextKey, pendingInfo] of this.pendingExternalRequests.entries()) {
      const requestEntry = pendingInfo.requestEntry;

      if (
        requestEntry.source !== incoming.source ||
        requestEntry.destination !== incoming.destination ||
        requestEntry.logTag !== incoming.logTag
      ) {
        continue;
      }

      if (
        currentEntry &&
        currentEntry.isRequest &&
        belongsToSameMultiTagFamily(requestEntry, currentEntry) &&
        belongsToSameMultiTagFamily(requestEntry, incoming) &&
        currentEntry.logTag !== requestEntry.logTag
      ) {
        this.logger.info('Skipping retry match for older pending external call because current replay entry expects a different sibling in same endpoint family', {
          currentEntryIndex: currentEntry.index,
          currentEntryLogTag: currentEntry.logTag,
          pendingEntryIndex: requestEntry.index,
          pendingEntryLogTag: requestEntry.logTag,
          incomingLogTag: incoming.logTag,
          api: incoming.api,
          contextKey
        });
        continue;
      }

      let contextMatches = true;
      if (incoming.loanApplicationId && requestEntry.loanApplicationId) {
        contextMatches = incoming.loanApplicationId === requestEntry.loanApplicationId;
      }
      if (contextMatches && incoming.lenderOrgId && requestEntry.lenderOrgId) {
        contextMatches = incoming.lenderOrgId === requestEntry.lenderOrgId;
      }

      if (contextMatches && !matchesKfsOpportunityId(incoming, requestEntry)) {
        this.logger.info('Skipping retry match because KFS opportunity id differs', {
          api: incoming.api,
          contextKey,
          incomingOpportunityId: extractOpportunityId(incoming),
          pendingOpportunityId: extractOpportunityId(requestEntry),
          pendingEntryIndex: requestEntry.index,
          pendingEntryLogTag: requestEntry.logTag
        });
        continue;
      }

      if (contextMatches && isAsyncParallelApi(requestEntry.sourceDestination, requestEntry.logTag)) {
        if (incoming.lenderOrgId !== requestEntry.lenderOrgId) {
          this.logger.debug('Not a retry - different lender for async parallel call', {
            incomingLender: incoming.lenderOrgId,
            expectedLender: requestEntry.lenderOrgId
          });
          continue;
        }
      }

      if (
        contextMatches &&
        currentEntry &&
        currentEntry.isRequest &&
        currentEntry.index !== requestEntry.index &&
        currentEntry.source === incoming.source &&
        currentEntry.destination === incoming.destination &&
        currentEntry.logTag === incoming.logTag
      ) {
        this.logger.info('Skipping retry match for older pending external call because incoming matches current replay entry', {
          currentEntryIndex: currentEntry.index,
          pendingEntryIndex: requestEntry.index,
          contextKey
        });
        continue;
      }

      if (contextMatches) {
        return {
          contextKey,
          requestEntry,
          responseEntry: pendingInfo.responseEntry
        };
      }
    }

    return null;
  }

  /**
   * Find a future unprocessed replay request that matches the incoming request.
   * If one exists, the incoming call belongs to a later replay step and must not
   * be short-circuited as a retry of an earlier completed request.
   *
   * @param {Object} incoming - The incoming request
   * @returns {Object|null} - Matching future replay entry or null
   */
  findFutureUnprocessedMatch(incoming) {
    const currentEntry = this.validator.getCurrentEntry();
    const currentPosition = currentEntry ? this.validator.currentIndex : -1;

    for (let i = currentPosition + 1; i < this.validator.entries.length; i++) {
      if (this.validator.processedIndices.has(i)) continue;

      const entry = this.validator.entries[i];
      if (!entry || !entry.isRequest || entry.shouldSkip()) continue;

      if (this.validator.matchesExpected(entry, incoming)) {
        return entry;
      }
    }

    return null;
  }

  /**
   * Find the corresponding response entry for a given request entry.
   * 
   * @param {Object} requestEntry - The request entry to find response for
   * @param {boolean} searchAll - Whether to search all entries including processed ones
   * @returns {Object|null} - The matching response entry or null
   */
  findCorrespondingResponse(requestEntry, searchAll = false) {
    return findCorrespondingResponseEntry(this.validator.entries, requestEntry, {
      searchAll,
      processedIndices: this.validator.processedIndices
    });
  }

  /**
   * Check if response matches request context (loan application ID, etc.)
   * 
   * @param {Object} requestEntry - The request entry
   * @param {Object} responseEntry - The response entry to match
   * @returns {boolean} - True if contexts match
   */
  matchesRequestContext(requestEntry, responseEntry) {
    return matchesRequestContext(requestEntry, responseEntry);
  }
}
