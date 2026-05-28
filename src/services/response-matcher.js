function normalizeRequestTag(logTag) {
  return (logTag || '').replace(/_REQUEST$/i, '');
}

function normalizeResponseTag(logTag) {
  return (logTag || '').replace(/_RESPONSE$/i, '');
}

export function matchesRequestContext(requestEntry, responseEntry) {
  if (!requestEntry || !responseEntry) {
    return false;
  }

  const requestTag = normalizeRequestTag(requestEntry.logTag);
  const responseTag = normalizeResponseTag(responseEntry.logTag);

  if (requestTag !== responseTag) {
    return false;
  }

  if (
    requestEntry.loanApplicationId &&
    responseEntry.loanApplicationId &&
    requestEntry.loanApplicationId !== responseEntry.loanApplicationId
  ) {
    return false;
  }

  if (
    requestEntry.lenderOrgId &&
    responseEntry.lenderOrgId &&
    requestEntry.lenderOrgId !== responseEntry.lenderOrgId
  ) {
    return false;
  }

  return true;
}

function findCandidateResponses(entries, requestEntry, searchAll = false, processedIndices = new Set()) {
  const direction = `${requestEntry.source}_${requestEntry.destination}`;

  return entries.filter(entry => {
    if (!entry?.isResponse) {
      return false;
    }

    if (!searchAll && processedIndices.has(entry.index)) {
      return false;
    }

    if (entry.sourceDestination !== direction) {
      return false;
    }

    if (entry.index <= requestEntry.index) {
      return false;
    }

    return matchesRequestContext(requestEntry, entry);
  });
}

function matchesRepeatedRequestContext(leftEntry, rightEntry) {
  if (!leftEntry || !rightEntry) {
    return false;
  }

  if (leftEntry.source !== rightEntry.source || leftEntry.destination !== rightEntry.destination) {
    return false;
  }

  if (leftEntry.logTag !== rightEntry.logTag) {
    return false;
  }

  if (
    leftEntry.loanApplicationId &&
    rightEntry.loanApplicationId &&
    leftEntry.loanApplicationId !== rightEntry.loanApplicationId
  ) {
    return false;
  }

  if (
    leftEntry.lenderOrgId &&
    rightEntry.lenderOrgId &&
    leftEntry.lenderOrgId !== rightEntry.lenderOrgId
  ) {
    return false;
  }

  return true;
}

function findMatchingRequestOrdinal(entries, requestEntry) {
  return entries.filter(entry =>
    entry?.isRequest &&
    entry.index <= requestEntry.index &&
    matchesRepeatedRequestContext(requestEntry, entry)
  ).length;
}

function findPriorMatchingResponseCount(entries, requestEntry) {
  return entries.filter(entry =>
    entry?.isResponse &&
    entry.index < requestEntry.index &&
    entry.sourceDestination === requestEntry.sourceDestination &&
    matchesRequestContext(requestEntry, entry)
  ).length;
}

export function findCorrespondingResponseEntry(entries, requestEntry, options = {}) {
  if (!requestEntry) {
    return null;
  }

  const {
    searchAll = false,
    processedIndices = new Set()
  } = options;

  const candidates = findCandidateResponses(entries, requestEntry, searchAll, processedIndices);
  if (candidates.length === 0) {
    return null;
  }

  const requestOrdinal = findMatchingRequestOrdinal(entries, requestEntry);
  const priorResponseCount = findPriorMatchingResponseCount(entries, requestEntry);
  const unmatchedOrdinal = Math.max(1, requestOrdinal - priorResponseCount);

  return candidates[Math.max(0, unmatchedOrdinal - 1)] || candidates[0];
}

export function findAllCorrespondingResponseEntries(entries, requestEntry, options = {}) {
  if (!requestEntry) {
    return [];
  }

  const {
    searchAll = true,
    processedIndices = new Set()
  } = options;

  return findCandidateResponses(entries, requestEntry, searchAll, processedIndices);
}
