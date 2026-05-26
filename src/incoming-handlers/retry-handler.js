import { isAsyncParallelApi } from '../config.js';
import { transformRequest } from '../services/request-transformer.js';

/**
 * RetryHandler - Handles retry detection for incoming requests
 * Checks if an incoming request is a retry of a previously processed request
 * and returns the cached response payload if found.
 */
export class RetryHandler {
  /**
   * @param {Object} dependencies - Dependencies for the handler
   * @param {Object} dependencies.validator - Validator instance with entries and processedIndices
   * @param {Map} dependencies.pendingExternalRequests - Map of pending external requests
   * @param {Object} dependencies.logger - Logger instance
   */
  constructor({ validator, pendingExternalRequests, logger }) {
    this.validator = validator;
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
        if (contextMatches && isAsyncParallelApi(requestEntry.sourceDestination, requestEntry.logTag)) {
          if (incoming.lenderOrgId !== requestEntry.lenderOrgId) {
            this.logger.debug('Not a retry - different lender for async parallel call', {
              incomingLender: incoming.lenderOrgId,
              expectedLender: requestEntry.lenderOrgId
            });
            continue; // Skip to next pending entry
          }
        }

        if (contextMatches && currentEntry && currentEntry.isRequest && currentEntry.index !== requestEntry.index && currentEntry.source === incoming.source && currentEntry.destination === incoming.destination && currentEntry.logTag === incoming.logTag) {
          this.logger.info('Skipping retry match for older pending external call because incoming matches current replay entry', {
            currentEntryIndex: currentEntry.index,
            pendingEntryIndex: requestEntry.index,
            contextKey
          });
          continue;
        }

        if (contextMatches) {
          this.logger.info('Detected retried request for pending external call', {
            source: incoming.source,
            destination: incoming.destination,
            api: incoming.api,
            contextKey
          });

          // Return the expected response payload
          return {
            success: true,
            payload: transformRequest(pendingInfo.responseEntry.payload, pendingInfo.responseEntry.logTag),
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
              payload: transformRequest(responseEntry.payload, responseEntry.logTag),
              retried: true
            };
          }
        }
      }
    }

    return null; // Not a retry
  }

  /**
   * Find the corresponding response entry for a given request entry.
   * 
   * @param {Object} requestEntry - The request entry to find response for
   * @param {boolean} searchAll - Whether to search all entries including processed ones
   * @returns {Object|null} - The matching response entry or null
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
   * 
   * @param {Object} requestEntry - The request entry
   * @param {Object} responseEntry - The response entry to match
   * @returns {boolean} - True if contexts match
   */
  matchesRequestContext(requestEntry, responseEntry) {
    // Match by log tag pattern - response should correspond to the request
    // e.g., "XXX_REQUEST" matches "XXX_RESPONSE"
    const requestTag = requestEntry.logTag.replace(/_REQUEST$/i, '').replace(/REQUEST$/i, '');
    const responseTag = responseEntry.logTag.replace(/_RESPONSE$/i, '').replace(/RESPONSE$/i, '');
    
    if (requestTag !== responseTag) {
      return false;
    }

    // Match by loan_application_id if present
    if (
      requestEntry.loanApplicationId &&
      responseEntry.loanApplicationId &&
      requestEntry.loanApplicationId !== responseEntry.loanApplicationId
    ) {
      return false;
    }
    // Match by lender_org_id if present
    if (
      requestEntry.lenderOrgId &&
      responseEntry.lenderOrgId &&
      requestEntry.lenderOrgId !== responseEntry.lenderOrgId
    ) {
      return false;
    }

    return true;
  }
}
