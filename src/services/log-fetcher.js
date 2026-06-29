import { readFile, writeFile } from 'fs/promises';
import { resolve } from 'path';

function getCreatedAtTime(log) {
  const createdAt = log?.message?.created_at;
  const timestamp = createdAt ? new Date(createdAt).getTime() : Number.NaN;
  return Number.isNaN(timestamp) ? Number.POSITIVE_INFINITY : timestamp;
}

function getLogDirectionPriority(log) {
  const logTag = (log?.message?.log_tag || '').trim().toUpperCase();

  if (logTag.endsWith('_REQUEST') || logTag.endsWith('REQUEST')) {
    return 0;
  }

  if (logTag.endsWith('_RESPONSE') || logTag.endsWith('RESPONSE')) {
    return 1;
  }

  return 2;
}

function getMessageNumber(log) {
  const messageNumber = Number(log?.messageNumber);
  return Number.isFinite(messageNumber) ? messageNumber : Number.POSITIVE_INFINITY;
}

function normalizeMissingTraceRoute(log) {
  const message = log?.message;
  if (!message || typeof message !== 'object') {
    return log;
  }

  const logTag = (message.log_tag || '').trim();
  const traceRoute = message.trace_route || '';
  const label = (message.label || '').trim();

  if (!traceRoute && (logTag === 'LSP-GetAgreementDataStatus_REQUEST' || label === 'APP')) {
    return {
      ...log,
      message: {
        ...message,
        trace_route: 'APP_CORE'
      }
    };
  }

  return log;
}

function shouldPreserveWithoutPayload(logTag, traceRoute) {
  return (
    logTag === 'LSP-GetAgreementDataStatus_REQUEST' &&
    traceRoute === 'APP_CORE'
  );
}

export function compareLogsForReplay(left, right) {
  const createdAtDiff = getCreatedAtTime(left) - getCreatedAtTime(right);
  if (createdAtDiff !== 0) {
    return createdAtDiff;
  }

  const directionDiff = getLogDirectionPriority(left) - getLogDirectionPriority(right);
  if (directionDiff !== 0) {
    return directionDiff;
  }

  const messageNumberDiff = getMessageNumber(left) - getMessageNumber(right);
  if (messageNumberDiff !== 0) {
    return messageNumberDiff;
  }

  const leftTag = (left?.message?.log_tag || '').trim();
  const rightTag = (right?.message?.log_tag || '').trim();
  const tagDiff = leftTag.localeCompare(rightTag);
  if (tagDiff !== 0) {
    return tagDiff;
  }

  const leftRoute = left?.message?.trace_route || '';
  const rightRoute = right?.message?.trace_route || '';
  return leftRoute.localeCompare(rightRoute);
}

function getPairingGroupKey(tagInfo, traceRoute) {
  // Some Themis flows log requests and responses on different trace routes,
  // but they are still one logical replay pair.
  if (
    tagInfo.baseTag === 'Themis-Eligibility' ||
    tagInfo.baseTag === 'Themis-KFS' ||
    tagInfo.baseTag === 'UpdateKYCRequest-LSP' ||
    tagInfo.baseTag === 'KYC SERVICE API' ||
    tagInfo.baseTag === 'LSP-LoanStatus' ||
    tagInfo.baseTag === 'Lsp-LoanStatusRequest' ||
    tagInfo.baseTag === 'ORDER_STATUS_API_LS' ||
    tagInfo.baseTag === 'FECTH_LOAN_APPLICATION_DATA_API' ||
    tagInfo.baseTag === 'OTP GENERATION API' ||
    tagInfo.baseTag === 'OTP AUTHENTICATION API'
  ) {
    return tagInfo.baseTag;
  }

  return `${tagInfo.baseTag}__${traceRoute}`;
}

function getRequestResponseTagInfo(logTag) {
  const normalizedTag = (logTag || '').trim();

  if (!normalizedTag) {
    return null;
  }

  if (/_REQUEST$/i.test(normalizedTag)) {
    return {
      kind: 'request',
      baseTag: normalizedTag.replace(/_REQUEST$/i, '')
    };
  }

  if (/REQUEST$/i.test(normalizedTag)) {
    return {
      kind: 'request',
      baseTag: normalizedTag.replace(/REQUEST$/i, '')
    };
  }

  if (/_RESPONSE$/i.test(normalizedTag)) {
    return {
      kind: 'response',
      baseTag: normalizedTag.replace(/_RESPONSE$/i, '')
    };
  }

  if (/RESPONSE$/i.test(normalizedTag)) {
    return {
      kind: 'response',
      baseTag: normalizedTag.replace(/RESPONSE$/i, '')
    };
  }

  return null;
}

const HARD_ELIGIBILITY_DEPENDENT_TAGS = new Set([
  'LSP-FetchOfferRequest_REQUEST',
  'LSP-FetchOfferRequest_RESPONSE',
  'POLLING API :: LINE_STATUS_REQUEST',
  'POLLING API :: LINE_STATUS_RESPONSE',
  'FETCH_OFFER_ASYNC_RESPONSE_REQUEST',
  'FETCH_OFFER_ASYNC_RESPONSE_RESPONSE',
  'LSP-HardEligibility_REQUEST',
  'LSP-HardEligibility_RESPONSE',
  'Themis-HardEligibility_REQUEST',
  'Themis-HardEligibility_RESPONSE',
  'FlipKart-HardEligibilityStatus_REQUEST',
  'FlipKart-HardEligibilityStatus_RESPONSE',
  'FlipKart-GetRedirectionURL_REQUEST',
  'FlipKart-GetRedirectionURL_RESPONSE',
  'ProcessStatus_REQUEST',
  'ProcessStatus_RESPONSE'
]);

const SELECT_OFFER_DEPENDENT_TAGS = new Set([
  'LOCK_TENURE_REQUEST',
  'LOCK_TENURE_RESPONSE',
  'GET_REDIRECTION_URL_SO_REQUEST',
  'GET_REDIRECTION_URL_SO_RESPONSE',
  'LSP-LoanStatus_REQUEST',
  'LSP-LoanStatus_RESPONSE',
  'Lsp-LoanStatusRequest_REQUEST',
  'Lsp-LoanStatusRequest_RESPONSE'
]);

function pruneDependentsAfterRemovedTrigger(logs, keepSet, {
  triggerTag,
  triggerRoute,
  dependentTags,
  reason
}) {
  const removedTriggerTimes = logs
    .map((log, index) => ({ log, index }))
    .filter(({ log, index }) => {
      const msg = log?.message || {};
      return !keepSet.has(index) && msg.trace_route === triggerRoute && msg.log_tag === triggerTag;
    })
    .map(({ log }) => getCreatedAtTime(log))
    .filter(timestamp => Number.isFinite(timestamp));

  if (removedTriggerTimes.length === 0) {
    return logs.filter((_, index) => keepSet.has(index));
  }

  const firstRemovedTriggerAt = Math.min(...removedTriggerTimes);

  return logs.filter((log, index) => {
    if (!keepSet.has(index)) {
      return false;
    }

    const msg = log?.message || {};
    const createdAt = getCreatedAtTime(log);
    const shouldPrune =
      createdAt >= firstRemovedTriggerAt &&
      dependentTags.has((msg.log_tag || '').trim());

    if (shouldPrune) {
      console.log(`Pruned orphaned ${reason} dependent log: index ${index}, trace_route: ${msg.trace_route}, log_tag: ${msg.log_tag}`);
    }

    return !shouldPrune;
  });
}

function pruneOrphanedHardEligibilityDependents(logs, keepSet) {
  return pruneDependentsAfterRemovedTrigger(logs, keepSet, {
    triggerTag: 'FlipKart-HardEligibility_REQUEST',
    triggerRoute: 'APP_WRAPPER',
    dependentTags: HARD_ELIGIBILITY_DEPENDENT_TAGS,
    reason: 'hard-eligibility'
  });
}

function pruneOrphanedSelectOfferDependents(logs, keepSet) {
  return pruneDependentsAfterRemovedTrigger(logs, keepSet, {
    triggerTag: 'LSP-SelectOffer_REQUEST',
    triggerRoute: 'CORE_GATEWAY',
    dependentTags: SELECT_OFFER_DEPENDENT_TAGS,
    reason: 'select-offer'
  });
}

function balanceRequestResponsePairs(logs) {
  const groups = new Map();
  const keepSet = new Set();
  const stats = new Map();

  logs.forEach((log, index) => {
    const msg = log?.message || {};
    const logTag = (msg.log_tag || '').trim();
    const traceRoute = msg.trace_route || '';
    const tagInfo = getRequestResponseTagInfo(logTag);

    if (!tagInfo) {
      keepSet.add(index);
      return;
    }

    const groupKey = getPairingGroupKey(tagInfo, traceRoute);
    const group = groups.get(groupKey) || {
      baseTag: tagInfo.baseTag,
      traceRoute,
      pendingRequests: []
    };

    const groupStats = stats.get(groupKey) || {
      baseTag: tagInfo.baseTag,
      traceRoute,
      requestsSeen: 0,
      responsesSeen: 0,
      pairsKept: 0
    };

    if (tagInfo.kind === 'request') {
      group.pendingRequests.push(index);
      groupStats.requestsSeen += 1;
    } else if (group.pendingRequests.length > 0) {
      const requestIndex = group.pendingRequests.shift();
      keepSet.add(requestIndex);
      keepSet.add(index);
      groupStats.responsesSeen += 1;
      groupStats.pairsKept += 1;
    } else {
      groupStats.responsesSeen += 1;
    }

    groups.set(groupKey, group);
    stats.set(groupKey, groupStats);
  });

  for (const groupStats of stats.values()) {
    if (groupStats.requestsSeen !== groupStats.responsesSeen) {
      console.log(
        `Balanced ${groupStats.baseTag} on [${groupStats.traceRoute}]: kept ${groupStats.pairsKept} pair(s), removed ${groupStats.requestsSeen - groupStats.pairsKept} request(s) and ${groupStats.responsesSeen - groupStats.pairsKept} response(s)`
      );
    }
  }

  const hardEligibilityPruned = pruneOrphanedHardEligibilityDependents(logs, keepSet);
  const keptAfterHardEligibilityPrune = new Set(hardEligibilityPruned.map(log => logs.indexOf(log)));
  return pruneOrphanedSelectOfferDependents(logs, keptAfterHardEligibilityPrune);
}

function extractReplayContextKey(log) {
  const msg = log?.message || {};
  const payload =
    msg.trace_request ||
    msg.trace_response ||
    msg.trace_payload ||
    {};

  return [
    msg.loan_application_id,
    payload.loanApplicationId,
    payload.loan_application_id,
    payload.applicationId,
    payload.applicationid,
    msg.order_id,
    payload.lineDetailId,
    payload.line_detail_id
  ].find(value => typeof value === 'string' && value.trim() !== '') || 'GLOBAL';
}

function extractFetchStatusOrderContextKey(log) {
  const msg = log?.message || {};
  const payload =
    msg.trace_request ||
    msg.trace_response ||
    msg.trace_payload ||
    {};

  const orderId =
    msg.order_id ||
    payload.order_id ||
    payload.orderId ||
    payload.merchant_order_placement_id ||
    payload.merchantOrderPlacementId ||
    null;

  const txnId =
    msg.txn_id ||
    payload.txn_id ||
    payload.txnId ||
    payload.merchant_order_id ||
    payload.merchantOrderId ||
    null;

  const merchantId = msg.merchant_id || payload.merchant_id || payload.merchantId || null;

  return [merchantId, orderId, txnId]
    .filter(value => typeof value === 'string' && value.trim() !== '')
    .join('::') || 'GLOBAL';
}

function resolvePendingOrderStatusResponseContext(contextKey, pendingResponsesByContext) {
  const exactPending = pendingResponsesByContext.get(contextKey) || 0;
  if (exactPending > 0) {
    return contextKey;
  }

  const [merchantId = '', orderId = ''] = contextKey.split('::');
  if (!merchantId || !orderId) {
    return null;
  }

  const prefix = `${merchantId}::${orderId}::`;
  for (const [candidateKey, pendingCount] of pendingResponsesByContext.entries()) {
    if (pendingCount > 0 && candidateKey.startsWith(prefix)) {
      return candidateKey;
    }
  }

  return null;
}

function fetchStatusContextKeysMatch(leftContextKey, rightContextKey) {
  if (leftContextKey === rightContextKey) {
    return true;
  }

  const [leftMerchantId = '', leftOrderId = ''] = (leftContextKey || '').split('::');
  const [rightMerchantId = '', rightOrderId = ''] = (rightContextKey || '').split('::');

  return Boolean(
    leftMerchantId &&
      leftOrderId &&
      rightMerchantId &&
      rightOrderId &&
      leftMerchantId === rightMerchantId &&
      leftOrderId === rightOrderId
  );
}

function getFetchStatusContextAliases(contextKey) {
  const aliases = new Set();
  if (!contextKey) {
    return aliases;
  }

  aliases.add(contextKey);
  const [merchantId = '', orderId = ''] = contextKey.split('::');
  if (merchantId && orderId) {
    aliases.add(`${merchantId}::${orderId}`);
  }

  return aliases;
}

function findPairRanges(logs, requestTag, responseTag) {
  const pendingByContext = new Map();
  const pairs = [];

  logs.forEach((log, index) => {
    const logTag = (log?.message?.log_tag || '').trim();
    const contextKey = extractReplayContextKey(log);

    if (logTag === requestTag) {
      const pending = pendingByContext.get(contextKey) || [];
      pending.push(index);
      pendingByContext.set(contextKey, pending);
      return;
    }

    if (logTag !== responseTag) {
      return;
    }

    const pending = pendingByContext.get(contextKey) || [];
    if (pending.length === 0) {
      return;
    }

    const requestIndex = pending.shift();
    pendingByContext.set(contextKey, pending);
    pairs.push({
      contextKey,
      requestIndex,
      responseIndex: index
    });
  });

  return pairs;
}

function reorderOutOfOrderKycPairs(logs) {
  const reordered = [...logs];
  const updatePairs = findPairRanges(
    reordered,
    'UpdateKYCRequest-LSP_REQUEST',
    'UpdateKYCRequest-LSP_RESPONSE'
  );
  const kycPairs = findPairRanges(
    reordered,
    'KYC SERVICE API_REQUEST',
    'KYC SERVICE API_RESPONSE'
  );

  if (updatePairs.length === 0 || kycPairs.length === 0) {
    return reordered;
  }

  let changed = false;

  for (const kycPair of kycPairs) {
    const updatePair = updatePairs.find(candidate =>
      candidate.contextKey === kycPair.contextKey &&
      candidate.requestIndex > kycPair.responseIndex &&
      candidate.responseIndex > candidate.requestIndex
    );

    if (!updatePair) {
      continue;
    }

    console.log(
      `Second-level filter: detected out-of-order UpdateKYC/KYC blocks for context ${kycPair.contextKey}. KYC pair=[${kycPair.requestIndex}-${kycPair.responseIndex}] UpdateKYC pair=[${updatePair.requestIndex}-${updatePair.responseIndex}]`
    );

    const before = reordered.slice(0, kycPair.requestIndex);
    const kycRequest = reordered[kycPair.requestIndex];
    const kycResponse = reordered[kycPair.responseIndex];
    const middle = reordered.slice(kycPair.responseIndex + 1, updatePair.requestIndex);
    const updateRequest = reordered[updatePair.requestIndex];
    const updateResponse = reordered[updatePair.responseIndex];
    const after = reordered.slice(updatePair.responseIndex + 1);

    reordered.splice(
      0,
      reordered.length,
      ...before,
      updateRequest,
      ...middle,
      kycRequest,
      kycResponse,
      updateResponse,
      ...after
    );

    console.log(
      `Second-level filter: reordered out-of-order UpdateKYC/KYC blocks for context ${kycPair.contextKey} into sequence UpdateKYCRequest-LSP_REQUEST -> KYC SERVICE API_REQUEST -> KYC SERVICE API_RESPONSE -> UpdateKYCRequest-LSP_RESPONSE`
    );

    const finalKycRequestIndex = reordered.findIndex(log => (log?.message?.log_tag || '').trim() === 'KYC SERVICE API_REQUEST');
    const finalKycResponseIndex = reordered.findIndex(log => (log?.message?.log_tag || '').trim() === 'KYC SERVICE API_RESPONSE');
    const finalUpdateRequestIndex = reordered.findIndex(log => (log?.message?.log_tag || '').trim() === 'UpdateKYCRequest-LSP_REQUEST');
    const finalUpdateResponseIndex = reordered.findIndex(log => (log?.message?.log_tag || '').trim() === 'UpdateKYCRequest-LSP_RESPONSE');

    console.log(
      `Second-level filter: final UpdateKYC/KYC order for context ${kycPair.contextKey}. UpdateKYC pair=[${finalUpdateRequestIndex}-${finalUpdateResponseIndex}] KYC pair=[${finalKycRequestIndex}-${finalKycResponseIndex}]`
    );
    changed = true;
    break;
  }

  if (!changed) {
    console.log('Second-level filter: no out-of-order UpdateKYC/KYC block detected');
  }

  return changed ? reordered : logs;
}

function findNextLogIndex(logs, startIndex, predicate) {
  for (let index = startIndex; index < logs.length; index += 1) {
    if (predicate(logs[index])) {
      return index;
    }
  }

  return -1;
}

function reorderFlipkartSmFetchStatusSequence(logs) {
  const reordered = [...logs];
  let changed = false;

  for (let index = 0; index < reordered.length; index += 1) {
    const current = reordered[index];
    const currentMessage = current?.message || {};
    const currentTag = (currentMessage.log_tag || '').trim();
    const currentMerchantId = currentMessage.merchant_id || null;

    if (currentTag !== 'FlipKart-FetchStatus_REQUEST' || currentMerchantId !== 'flipkartSM') {
      continue;
    }

    const contextKey = extractFetchStatusOrderContextKey(current);
    const fetchStatusResponseIndex = findNextLogIndex(
      reordered,
      index + 1,
      log => {
        const message = log?.message || {};
        return (
          (message.log_tag || '').trim() === 'FlipKart-FetchStatus_RESPONSE' &&
          fetchStatusContextKeysMatch(extractFetchStatusOrderContextKey(log), contextKey)
        );
      }
    );

    if (fetchStatusResponseIndex === -1) {
      continue;
    }

    const coreGatewayIndex = findNextLogIndex(
      reordered,
      fetchStatusResponseIndex + 1,
      log => {
        const message = log?.message || {};
        return (
          (message.log_tag || '').trim() === 'Lsp-LoanStatusRequest_REQUEST' &&
          fetchStatusContextKeysMatch(extractFetchStatusOrderContextKey(log), contextKey)
        );
      }
    );

    const orderStatusRequestIndex = findNextLogIndex(
      reordered,
      fetchStatusResponseIndex + 1,
      log => {
        const message = log?.message || {};
        return (
          (message.log_tag || '').trim() === 'ORDER_STATUS_API_LS_REQUEST' &&
          fetchStatusContextKeysMatch(extractFetchStatusOrderContextKey(log), contextKey)
        );
      }
    );

    const fetchLoanApplicationDataIndex = findNextLogIndex(
      reordered,
      fetchStatusResponseIndex + 1,
      log => {
        const message = log?.message || {};
        return (
          (message.log_tag || '').trim() === 'FECTH_LOAN_APPLICATION_DATA_API_REQUEST' &&
          fetchStatusContextKeysMatch(extractFetchStatusOrderContextKey(log), contextKey)
        );
      }
    );

    const loanStatusAsyncIndex = findNextLogIndex(
      reordered,
      fetchStatusResponseIndex + 1,
      log => {
        const message = log?.message || {};
        return (
          (message.log_tag || '').trim() === 'LOAN_STATUS_ASYNC_RESPONSE_REQUEST' &&
          fetchStatusContextKeysMatch(extractFetchStatusOrderContextKey(log), contextKey)
        );
      }
    );

    const requiredIndexes = [
      coreGatewayIndex,
      orderStatusRequestIndex,
      fetchLoanApplicationDataIndex,
      loanStatusAsyncIndex
    ];

    if (requiredIndexes.some(candidateIndex => candidateIndex === -1)) {
      continue;
    }

    const currentSequence = [coreGatewayIndex, orderStatusRequestIndex, fetchLoanApplicationDataIndex, loanStatusAsyncIndex];
    const expectedSortedSequence = [...currentSequence].sort((left, right) => left - right);
    const alreadyOrdered = currentSequence.every((value, sequenceIndex) => value === expectedSortedSequence[sequenceIndex]);

    if (alreadyOrdered) {
      console.log(`Second-level filter: flipkartSM fetch-status sequence already ordered for context ${contextKey}`);
      continue;
    }

    const entryGroups = [
      {
        label: 'Lsp-LoanStatusRequest_REQUEST',
        items: reordered.splice(coreGatewayIndex, 1)
      },
      {
        label: 'ORDER_STATUS_API_LS_REQUEST',
        items: reordered.splice(orderStatusRequestIndex - (orderStatusRequestIndex > coreGatewayIndex ? 1 : 0), 1)
      },
      {
        label: 'FECTH_LOAN_APPLICATION_DATA_API_REQUEST',
        items: reordered.splice(
          fetchLoanApplicationDataIndex -
            (fetchLoanApplicationDataIndex > coreGatewayIndex ? 1 : 0) -
            (fetchLoanApplicationDataIndex > orderStatusRequestIndex ? 1 : 0),
          1
        )
      },
      {
        label: 'LOAN_STATUS_ASYNC_RESPONSE_REQUEST',
        items: reordered.splice(
          loanStatusAsyncIndex -
            (loanStatusAsyncIndex > coreGatewayIndex ? 1 : 0) -
            (loanStatusAsyncIndex > orderStatusRequestIndex ? 1 : 0) -
            (loanStatusAsyncIndex > fetchLoanApplicationDataIndex ? 1 : 0),
          1
        )
      }
    ];

    const insertionIndex = fetchStatusResponseIndex + 1;
    reordered.splice(
      insertionIndex,
      0,
      ...entryGroups[0].items,
      ...entryGroups[1].items,
      ...entryGroups[2].items,
      ...entryGroups[3].items
    );

    console.log(
      `Second-level filter: forcibly reordered flipkartSM fetch-status sequence for context ${contextKey} into FlipKart-FetchStatus_REQUEST -> Lsp-LoanStatusRequest_REQUEST -> ORDER_STATUS_API_LS_REQUEST -> FECTH_LOAN_APPLICATION_DATA_API_REQUEST -> LOAN_STATUS_ASYNC_RESPONSE_REQUEST`
    );

    changed = true;
  }

  return changed ? reordered : logs;
}

function synthesizeMissingGatewayLenderRequests(logs) {
  const rewritten = [...logs];
  let changed = false;
  const pendingRequests = new Map();

  for (let index = 0; index < rewritten.length; index += 1) {
    const current = rewritten[index];
    const currentMessage = current?.message || {};
    const currentTag = (currentMessage.log_tag || '').trim();
    const traceRoute = (currentMessage.trace_route || '').trim();
    const tagInfo = getRequestResponseTagInfo(currentTag);

    if (!['GATEWAY_LENDER', 'LENDER_GATEWAY'].includes(traceRoute) || !tagInfo) {
      continue;
    }

    const contextKey = extractReplayContextKey(current);
    const pendingKey = `${contextKey}::${tagInfo.baseTag}`;
    const pendingCount = pendingRequests.get(pendingKey) || 0;

    if (tagInfo.kind === 'request') {
      pendingRequests.set(pendingKey, pendingCount + 1);
      continue;
    }

    if (pendingCount > 0) {
      pendingRequests.set(pendingKey, pendingCount - 1);
      continue;
    }

    const responseMessage = currentMessage;
    const syntheticRequest = {
      ...current,
      message: {
        ...responseMessage,
        log_tag: `${tagInfo.baseTag}_REQUEST`,
        trace_route: 'GATEWAY_LENDER',
        trace_request: responseMessage.trace_request || {},
        trace_response: null,
        trace_request_ack: null,
        trace_response_ack: null,
        trace_error_msg: null
      }
    };

    rewritten.splice(index, 0, syntheticRequest);
    console.log(
      `Second-level filter: synthesized missing ${tagInfo.baseTag}_REQUEST before ${currentTag} for context ${contextKey}`
    );
    changed = true;
    pendingRequests.set(pendingKey, 0);
    index += 1;
  }

  return changed ? rewritten : logs;
}

function pruneOrphanedGatewayLoanStatusRequests(logs) {
  const availableTriggersByContext = new Map();
  const filtered = [];
  let removedCount = 0;

  for (const log of logs) {
    const msg = log?.message || {};
    const logTag = (msg.log_tag || '').trim();
    const contextKey = extractReplayContextKey(log);
    const orderStatusContextKey = extractFetchStatusOrderContextKey(log);

    if (
      logTag === 'LSP-LoanStatus_REQUEST' ||
      logTag === 'FlipKart-FetchStatus_REQUEST' ||
      logTag === 'ORDER_STATUS_API_LS_REQUEST'
    ) {
      const available = availableTriggersByContext.get(contextKey) || 0;
      availableTriggersByContext.set(contextKey, available + 1);
      for (const aliasKey of getFetchStatusContextAliases(orderStatusContextKey)) {
        if (aliasKey === contextKey) {
          continue;
        }
        const orderContextAvailable = availableTriggersByContext.get(aliasKey) || 0;
        availableTriggersByContext.set(aliasKey, orderContextAvailable + 1);
      }
      filtered.push(log);
      continue;
    }

    if (logTag === 'Lsp-LoanStatusRequest_REQUEST') {
      const candidateKeys = [
        contextKey,
        ...Array.from(getFetchStatusContextAliases(orderStatusContextKey))
      ];
      const consumeFromKey = candidateKeys.find(candidateKey => (availableTriggersByContext.get(candidateKey) || 0) > 0);
      const available = consumeFromKey ? (availableTriggersByContext.get(consumeFromKey) || 0) : 0;

      if (available > 0) {
        availableTriggersByContext.set(consumeFromKey, available - 1);
        filtered.push(log);
      } else {
        removedCount += 1;
        console.log(
          `Second-level filter: removing orphaned CORE->GATEWAY loan status request for context ${contextKey}, request_id: ${msg.request_id || ''}`
        );
      }
      continue;
    }

    filtered.push(log);
  }

  if (removedCount > 0) {
    console.log(
      `Second-level filter: removed ${removedCount} orphaned Lsp-LoanStatusRequest_REQUEST entr${removedCount === 1 ? 'y' : 'ies'} based on missing prior LSP-LoanStatus_REQUEST trigger`
    );
  }

  return filtered;
}

function pruneOrphanedHdbLoanStatusFlows(logs) {
  const availableTriggersByContext = new Map();
  const pendingLenderResponsesByContext = new Map();
  const pendingAsyncRequestsByContext = new Map();
  const pendingAsyncResponsesByContext = new Map();
  const observedHdbLoanStatusContexts = new Set();
  const filtered = [];
  let removedRequests = 0;
  let removedResponses = 0;
  let removedAsyncRequests = 0;
  let removedAsyncResponses = 0;

  for (const log of logs) {
    const msg = log?.message || {};
    const logTag = (msg.log_tag || '').trim();
    const contextKey = extractReplayContextKey(log);
    const candidateKeys = [contextKey, ...Array.from(getFetchStatusContextAliases(extractFetchStatusOrderContextKey(log)))];

    if (logTag === 'Lsp-LoanStatusRequest_REQUEST') {
      for (const candidateKey of candidateKeys) {
        const available = availableTriggersByContext.get(candidateKey) || 0;
        availableTriggersByContext.set(candidateKey, available + 1);
      }
      filtered.push(log);
      continue;
    }

    if (logTag === 'HDB_APPLICATION_STATUS_API :: LOAN_STATUS_REQUEST') {
      for (const candidateKey of candidateKeys) {
        observedHdbLoanStatusContexts.add(candidateKey);
      }
      const consumeFromKey = candidateKeys.find(candidateKey => (availableTriggersByContext.get(candidateKey) || 0) > 0);
      const available = consumeFromKey ? (availableTriggersByContext.get(consumeFromKey) || 0) : 0;

      if (available > 0) {
        availableTriggersByContext.set(consumeFromKey, available - 1);
        pendingLenderResponsesByContext.set(consumeFromKey, (pendingLenderResponsesByContext.get(consumeFromKey) || 0) + 1);
        pendingAsyncRequestsByContext.set(consumeFromKey, (pendingAsyncRequestsByContext.get(consumeFromKey) || 0) + 1);
        filtered.push(log);
      } else {
        removedRequests += 1;
        console.log(
          `Second-level filter: removing orphaned HDB loan-status request without prior Lsp-LoanStatusRequest_REQUEST trigger for context ${contextKey}, request_id: ${msg.request_id || ''}`
        );
      }
      continue;
    }

    if (logTag === 'HDB_APPLICATION_STATUS_API :: LOAN_STATUS_RESPONSE') {
      for (const candidateKey of candidateKeys) {
        observedHdbLoanStatusContexts.add(candidateKey);
      }
      const matchedContextKey = candidateKeys.find(candidateKey => (pendingLenderResponsesByContext.get(candidateKey) || 0) > 0);
      const pendingResponses = matchedContextKey ? (pendingLenderResponsesByContext.get(matchedContextKey) || 0) : 0;

      if (pendingResponses > 0) {
        pendingLenderResponsesByContext.set(matchedContextKey, pendingResponses - 1);
        filtered.push(log);
      } else {
        removedResponses += 1;
        console.log(
          `Second-level filter: removing orphaned HDB loan-status response without kept request for context ${contextKey}, request_id: ${msg.request_id || ''}`
        );
      }
      continue;
    }

    if (logTag === 'LOAN_STATUS_ASYNC_RESPONSE_REQUEST') {
      const shouldApplyHdbAsyncPrune = candidateKeys.some(candidateKey => observedHdbLoanStatusContexts.has(candidateKey));
      if (!shouldApplyHdbAsyncPrune) {
        filtered.push(log);
        continue;
      }

      const matchedContextKey = candidateKeys.find(candidateKey => (pendingAsyncRequestsByContext.get(candidateKey) || 0) > 0);
      const pendingRequests = matchedContextKey ? (pendingAsyncRequestsByContext.get(matchedContextKey) || 0) : 0;

      if (pendingRequests > 0) {
        pendingAsyncRequestsByContext.set(matchedContextKey, pendingRequests - 1);
        pendingAsyncResponsesByContext.set(matchedContextKey, (pendingAsyncResponsesByContext.get(matchedContextKey) || 0) + 1);
        filtered.push(log);
      } else {
        removedAsyncRequests += 1;
        console.log(
          `Second-level filter: removing orphaned LOAN_STATUS_ASYNC_RESPONSE_REQUEST without kept HDB loan-status request for context ${contextKey}, request_id: ${msg.request_id || ''}`
        );
      }
      continue;
    }

    if (logTag === 'LOAN_STATUS_ASYNC_RESPONSE_RESPONSE') {
      const shouldApplyHdbAsyncPrune = candidateKeys.some(candidateKey => observedHdbLoanStatusContexts.has(candidateKey));
      if (!shouldApplyHdbAsyncPrune) {
        filtered.push(log);
        continue;
      }

      const matchedContextKey = candidateKeys.find(candidateKey => (pendingAsyncResponsesByContext.get(candidateKey) || 0) > 0);
      const pendingResponses = matchedContextKey ? (pendingAsyncResponsesByContext.get(matchedContextKey) || 0) : 0;

      if (pendingResponses > 0) {
        pendingAsyncResponsesByContext.set(matchedContextKey, pendingResponses - 1);
        filtered.push(log);
      } else {
        removedAsyncResponses += 1;
        console.log(
          `Second-level filter: removing orphaned LOAN_STATUS_ASYNC_RESPONSE_RESPONSE without kept async request for context ${contextKey}, request_id: ${msg.request_id || ''}`
        );
      }
      continue;
    }

    filtered.push(log);
  }

  if (removedRequests > 0 || removedResponses > 0 || removedAsyncRequests > 0 || removedAsyncResponses > 0) {
    console.log(
      `Second-level filter: removed ${removedRequests} orphaned HDB loan-status request entr${removedRequests === 1 ? 'y' : 'ies'}, ` +
      `${removedResponses} orphaned HDB loan-status response entr${removedResponses === 1 ? 'y' : 'ies'}, ` +
      `${removedAsyncRequests} orphaned async loan-status request entr${removedAsyncRequests === 1 ? 'y' : 'ies'}, and ` +
      `${removedAsyncResponses} orphaned async loan-status response entr${removedAsyncResponses === 1 ? 'y' : 'ies'}`
    );
  }

  return filtered;
}

function pruneOrphanedOrderStatusAfterFetchStatus(logs) {
  const availableTriggersByContext = new Map();
  const pendingResponsesByContext = new Map();
  const filtered = [];
  let removedRequests = 0;
  let removedResponses = 0;

  for (const log of logs) {
    const msg = log?.message || {};
    const logTag = (msg.log_tag || '').trim();
    const contextKey = extractFetchStatusOrderContextKey(log);

    if (logTag === 'FlipKart-FetchStatus_REQUEST') {
      const available = availableTriggersByContext.get(contextKey) || 0;
      availableTriggersByContext.set(contextKey, available + 1);
      filtered.push(log);
      continue;
    }

    if (logTag === 'ORDER_STATUS_API_LS_REQUEST') {
      const available = availableTriggersByContext.get(contextKey) || 0;

      if (available > 0) {
        availableTriggersByContext.set(contextKey, available - 1);
        pendingResponsesByContext.set(contextKey, (pendingResponsesByContext.get(contextKey) || 0) + 1);
        filtered.push(log);
      } else {
        removedRequests += 1;
        console.log(
          `Second-level filter: removing orphaned ORDER_STATUS_API_LS_REQUEST without prior FlipKart-FetchStatus_REQUEST for context ${contextKey}, request_id: ${msg.request_id || ''}`
        );
      }
      continue;
    }

    if (logTag === 'ORDER_STATUS_API_LS_RESPONSE') {
      const matchedContextKey = resolvePendingOrderStatusResponseContext(contextKey, pendingResponsesByContext);
      const pendingResponses = matchedContextKey ? (pendingResponsesByContext.get(matchedContextKey) || 0) : 0;

      if (pendingResponses > 0) {
        pendingResponsesByContext.set(matchedContextKey, pendingResponses - 1);
        filtered.push(log);
      } else {
        removedResponses += 1;
        console.log(
          `Second-level filter: removing orphaned ORDER_STATUS_API_LS_RESPONSE without kept request for context ${contextKey}, request_id: ${msg.request_id || ''}`
        );
      }
      continue;
    }

    filtered.push(log);
  }

  if (removedRequests > 0 || removedResponses > 0) {
    console.log(
      `Second-level filter: removed ${removedRequests} orphaned ORDER_STATUS_API_LS_REQUEST entr${removedRequests === 1 ? 'y' : 'ies'} and ${removedResponses} orphaned ORDER_STATUS_API_LS_RESPONSE entr${removedResponses === 1 ? 'y' : 'ies'} based on missing prior FlipKart-FetchStatus_REQUEST trigger`
    );
  }

  return filtered;
}

function shouldSkipLog(log) {
  const msg = log?.message || {};
  const traceRoute = msg.trace_route || '';
  const logTag = (msg.log_tag || '').trim();

  if (traceRoute === 'CORE_APP') {
    return true;
  }

  if (logTag.includes('.')) {
    return true;
  }
  
  if (traceRoute.startsWith('WRAPPER_') || traceRoute.endsWith('_WRAPPER')) {
    if (traceRoute === 'APP_WRAPPER') {
      return false;
    }
    return true;
  }
  
  if (logTag.includes('_ENCRYPTED')) {
    return true;
  }

  // Async fetch-offer completion is already represented by
  // FETCH_OFFER_ASYNC_RESPONSE_RESPONSE in the replay flow.
  if (logTag === 'LSP-FetchOfferResponse_RESPONSE') {
    return true;
  }

  // Loan status async callback is logged twice in the journey:
  // once as the actionable GATEWAY_LSP pair and again as a redundant
  // GATEWAY_CORE LoanStatusResponse request/response echo.
  if (
    traceRoute === 'GATEWAY_CORE' &&
    (logTag === 'LoanStatusResponse_REQUEST' || logTag === 'LoanStatusResponse_RESPONSE')
  ) {
    return true;
  }
  
  if (!logTag || logTag === '') {
    return true;
  }
  
  return false;
}

/**
 * Perform second-level filtering to remove entries that orchestrator would skip
 * This ensures final-filtered logs only contain actionable entries
 * @param {Array} logs - Logs after first-level filtering
 * @param {string} outputPath - Optional path to save final filtered logs (e.g., 'data/final-filtered-logs.json')
 * @returns {Array} - Logs with orchestrator-skip entries removed
 */
export async function filterOrchestratorSkippableLogs(logs, outputPath = null) {
  if (!Array.isArray(logs) || logs.length === 0) {
    return [];
  }

  const filtered = logs.filter((log, index) => {
    const shouldSkip = shouldSkipLog(log);
    
    if (shouldSkip) {
      const msg = log?.message || {};
      console.log(`Second-level filter: skipping index ${index}, trace_route: ${msg.trace_route}, log_tag: ${msg.log_tag}`);
    }
    
    return !shouldSkip;
  });

  console.log(`Second-level filtering: ${logs.length} -> ${filtered.length} (removed ${logs.length - filtered.length} orchestrator-skipped entries)`);

  const reordered = reorderOutOfOrderKycPairs(filtered);
  const flipkartSmReordered = reorderFlipkartSmFetchStatusSequence(reordered);
  const gatewayLenderCompleted = synthesizeMissingGatewayLenderRequests(flipkartSmReordered);
  const fetchStatusTriggerPruned = pruneOrphanedOrderStatusAfterFetchStatus(gatewayLenderCompleted);
  const lenderLoanStatusPruned = pruneOrphanedHdbLoanStatusFlows(fetchStatusTriggerPruned);
  const balanced = balanceRequestResponsePairs(lenderLoanStatusPruned);
  
  // Save final filtered logs to file if outputPath provided
  if (outputPath) {
    try {
      const absolutePath = resolve(process.cwd(), outputPath);
      await writeFile(absolutePath, JSON.stringify(balanced, null, 2), 'utf-8');
      console.log(`Saved final filtered logs to: ${outputPath}`);
    } catch (error) {
      console.error(`Failed to save final filtered logs: ${error.message}`);
    }
  }
  
  return balanced;
}

/**
 * Fetch logs from the JSON API endpoint
 * The JSON file is populated with data from ClickHouse/S3
 */

/**
 * Fetch logs for given order IDs from the logs API
 * @param {string} apiUrl - The API endpoint that returns the logs JSON
 * @param {string[]} orderIds - Array of order IDs to fetch logs for
 * @returns {Promise<Array>} - Array of log entries sorted by messageNumber
 */
export async function fetchLogsFromAPI(apiUrl, orderIds) {
  try {
    const response = await fetch(apiUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({ orderIds })
    });

    if (!response.ok) {
      throw new Error(`HTTP error! status: ${response.status}`);
    }

    const data = await response.json();

    // Validate response structure
    if (!Array.isArray(data)) {
      throw new Error('Invalid response format: expected array of logs');
    }

    // Sort logs by messageNumber to ensure correct sequence
    const sortedLogs = data.sort((a, b) => {
      const numA = a.messageNumber || 0;
      const numB = b.messageNumber || 0;
      return numA - numB;
    });

    console.log(`Fetched ${sortedLogs.length} logs from API`);
    return sortedLogs;

  } catch (error) {
    throw new Error(`Failed to fetch logs: ${error.message}`);
  }
}

/**
 * Alternative: Read logs from a local JSON file in the repo directory
 * Useful for testing with sample data or pre-downloaded logs
 * @param {string} filePath - Relative path from repo root to the JSON file (e.g., 'data/logs.json')
 * @returns {Promise<Array>} - Array of log entries
 */
export async function fetchLogsFromJSONFile(filePath) {
  try {
    // Resolve path relative to repo root (where the script is executed from)
    const absolutePath = resolve(process.cwd(), filePath);

    // Read and parse the JSON file
    const fileContent = await readFile(absolutePath, 'utf-8');
    const data = JSON.parse(fileContent);

    if (!Array.isArray(data)) {
      throw new Error('Invalid JSON format: expected array of logs');
    }

    // Sort logs by messageNumber
    const sortedLogs = data.sort(compareLogsForReplay);

    console.log(`Loaded ${sortedLogs.length} logs from ${filePath}`);
    return sortedLogs;

  } catch (error) {
    if (error.code === 'ENOENT') {
      throw new Error(`Log file not found: ${filePath}`);
    }
    if (error instanceof SyntaxError) {
      throw new Error(`Invalid JSON in file ${filePath}: ${error.message}`);
    }
    throw new Error(`Failed to load logs from file: ${error.message}`);
  }
}

/**
 * Filter and sort logs by removing duplicates and sorting by created_at
 * Duplicate key: request_id + log_tag + trace_route
 * Keeps first occurrence, removes subsequent duplicates
 * @param {Array} logs - Raw logs array
 * @param {string} outputPath - Optional path to save filtered logs (e.g., 'data/filtered-logs.json')
 * @returns {Array} - Filtered and sorted logs
 */
export async function filterAndSortLogs(logs, outputPath = null) {
  if (!Array.isArray(logs) || logs.length === 0) {
    return [];
  }

  const normalizedLogs = logs.map(normalizeMissingTraceRoute);
  const sortedByTime = [...normalizedLogs].sort(compareLogsForReplay);
  const seen = new Set();
  const duplicates = [];
  const missingPayloadLogs = [];

  const filtered = sortedByTime.filter((log, index) => {
    const msg = log?.message || {};
    const logTag = (msg.log_tag || '').trim();
    const traceRoute = msg.trace_route || '';

    const hasTraceRequest = msg.trace_request !== undefined && msg.trace_request !== null;
    const hasTraceResponse = msg.trace_response !== undefined && msg.trace_response !== null;
    const hasTraceError = msg.trace_error_msg !== undefined && msg.trace_error_msg !== null;
    const hasTraceRequestAck = msg.trace_request_ack !== undefined && msg.trace_request_ack !== null;
    const hasTraceResponseAck = msg.trace_response_ack !== undefined && msg.trace_response_ack !== null;
    const preserveWithoutPayload = shouldPreserveWithoutPayload(logTag, traceRoute);

    if (!hasTraceRequest && !hasTraceResponse && !hasTraceError && !hasTraceRequestAck && !hasTraceResponseAck && !preserveWithoutPayload) {
      if (logTag.includes('HardEligibility')) {
        console.log(`First-level filter: dropping hard eligibility log without payload/ack at sorted index ${index}, trace_route: ${traceRoute}, log_tag: ${logTag}, request_id: ${msg.request_id || log?.xRequestId || ''}`);
      }

      missingPayloadLogs.push({
        index,
        requestId: msg.request_id || log?.xRequestId || '',
        logTag,
        traceRoute,
        checkpoint: msg.checkpoint || 'N/A'
      });
      return false;
    }

    const requestId = msg.request_id || log?.xRequestId || '';

    const key = `${requestId}_${logTag}_${traceRoute}`;

    if (seen.has(key)) {
      if (logTag.includes('HardEligibility')) {
        console.log(`First-level filter: dropping duplicate hard eligibility log at sorted index ${index}, key: ${key}`);
      }

      duplicates.push({ index, key: key.substring(0, 60), logTag });
      return false;
    }

    if (logTag.startsWith('CHECKOUT.')) {
      if (logTag.includes('HardEligibility')) {
        console.log(`First-level filter: dropping checkout hard eligibility log at sorted index ${index}, log_tag: ${logTag}`);
      }

      return false;
    }

    seen.add(key);
    return true;
  });

  if (missingPayloadLogs.length > 0) {
    console.log(`Removed ${missingPayloadLogs.length} logs without trace_request/trace_response/ack payloads (checkpoint/metadata logs)`);
    console.log(`Sample logs removed:`, missingPayloadLogs.slice(0, 3));
  }

  const sorted = filtered;

  console.log(`Filtered logs: ${logs.length} -> ${sorted.length} (removed ${duplicates.length} duplicates)`);
  if (duplicates.length > 0) {
    console.log(`Sample duplicates removed:`, duplicates.slice(0, 3));
  }

  // Save filtered logs to file if outputPath provided
  if (outputPath) {
    try {
      const absolutePath = resolve(process.cwd(), outputPath);
      await writeFile(absolutePath, JSON.stringify(sorted, null, 2), 'utf-8');
      console.log(`Saved filtered logs to: ${outputPath}`);
    } catch (error) {
      console.error(`Failed to save filtered logs: ${error.message}`);
    }
  }

  return sorted;
}

/**
 * Fetch order IDs from ClickHouse via API
 * @param {string} clickhouseApiUrl - API endpoint to fetch order IDs
 * @param {Object} filters - Optional filters (date range, merchant, etc.)
 * @returns {Promise<string[]>} - Array of order IDs
 */
export async function fetchOrderIdsFromClickHouse(clickhouseApiUrl, filters = {}) {
  try {
    const response = await fetch(clickApiUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json'
      },
      body: JSON.stringify(filters)
    });

    if (!response.ok) {
      throw new Error(`HTTP error! status: ${response.status}`);
    }

    const data = await response.json();

    if (!Array.isArray(data)) {
      throw new Error('Invalid response format: expected array of order IDs');
    }

    console.log(`Fetched ${data.length} order IDs from ClickHouse`);
    return data;

  } catch (error) {
    throw new Error(`Failed to fetch order IDs: ${error.message}`);
  }
}
