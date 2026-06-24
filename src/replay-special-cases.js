export const REPLAY_SPECIAL_CASES = [
  {
    logTag: 'Themis-Eligibility_REQUEST',
    handler: 'handleThemisEligibilityBatch',
    description: 'Batch-match Themis eligibility requests by lenderOrgId and advance replay as a group.'
  },
  {
    logTag: 'Themis-KFS_REQUEST',
    handler: 'handleThemisKFSReq',
    description: 'Batch-match Themis KFS requests by lenderOrgId and tolerate payload drift for replay stability.'
  },
  {
    logTag: 'POLLING API :: LINE_STATUS_REQUEST',
    handler: 'maybeSkipOptionalRepeatedEntry',
    description: 'Allow repeated polling requests to be skipped after one successful occurrence if later repeats never arrive.',
    optionalAfterSeconds: 5,
    requirePriorProcessedOccurrence: true,
    advanceWhenSeenLogTags: [
      'CREATE APPLICATION API_REQUEST',
      'FETCH_OFFER_ASYNC_RESPONSE_REQUEST'
    ]
  },
  {
    logTag: 'GET_CHECKOUT_STATUS_LINE_STATUS_REQUEST',
    handler: 'maybeSkipOptionalRepeatedEntry',
    description: 'Allow repeated checkout-status polling requests to be skipped after one successful occurrence if later repeats never arrive.',
    optionalAfterSeconds: 5,
    requirePriorProcessedOccurrence: true
  },
  {
    logTag: 'GET_CHECKOUT_STATUS_LS_REQUEST',
    handler: 'maybeSkipOptionalRepeatedEntry',
    description: 'Allow repeated checkout-status polling requests to be skipped after one successful occurrence if later repeats never arrive.',
    optionalAfterSeconds: 5,
    requirePriorProcessedOccurrence: true
  },
  {
    logTag: 'GET_CHECKOUT_STATUS_FO_REQUEST',
    handler: 'maybeSkipOptionalRepeatedEntry',
    description: 'Allow repeated checkout-status polling requests to be skipped after one successful occurrence if later repeats never arrive.',
    optionalAfterSeconds: 5,
    requirePriorProcessedOccurrence: true
  },
  {
    logTag: 'LenderLineStatus_RESPONSE',
    handler: 'maybeSkipOptionalRepeatedResponseEntry',
    description: 'Allow repeated line-status responses to be skipped after one successful occurrence if later repeats never arrive.',
    optionalAfterSeconds: 5,
    requirePriorProcessedOccurrence: true
  },
  {
    logTag: 'Lsp-LoanStatusRequest_REQUEST',
    handler: 'maybeSkipOptionalRepeatedEntry',
    description: 'Allow repeated loan-status gateway polling requests to be skipped after one successful occurrence if later repeats never arrive.',
    optionalAfterSeconds: 5,
    requirePriorProcessedOccurrence: true
  },
  {
    logTag: 'Lsp-LoanStatusRequest_RESPONSE',
    handler: 'maybeSkipOptionalRepeatedResponseEntry',
    description: 'Allow repeated loan-status gateway polling responses to be skipped after one successful occurrence if later repeats never arrive.',
    optionalAfterSeconds: 5,
    requirePriorProcessedOccurrence: true
  },
  {
    logTag: 'LSP-LoanStatus_REQUEST',
    handler: 'maybeSkipOptionalRepeatedEntry',
    description: 'Allow repeated app loan-status polling requests to be skipped after one successful occurrence if later repeats never arrive.',
    optionalAfterSeconds: 5,
    requirePriorProcessedOccurrence: true
  },
  {
    logTag: 'LSP-LoanStatus_RESPONSE',
    handler: 'maybeSkipOptionalRepeatedResponseEntry',
    description: 'Allow repeated app loan-status polling responses to be skipped after one successful occurrence if later repeats never arrive.',
    optionalAfterSeconds: 5,
    requirePriorProcessedOccurrence: true
  },
  {
    logTag: 'PROFILE_INGESTION_REQUEST',
    handler: 'maybeSkipOptionalRepeatedEntry',
    description: 'Allow profile ingestion to be skipped when the live branch has already advanced into later fetch-offer steps.',
    optionalAfterSeconds: 5,
    requirePriorProcessedOccurrence: false,
    advanceWhenSeenLogTags: [
      'LSP-FetchOfferRequest_REQUEST',
      'FETCH_OFFER_ASYNC_RESPONSE_REQUEST'
    ]
  },
  {
    logTag: 'LSP-FetchOfferRequest_REQUEST',
    handler: 'maybeSkipOptionalRepeatedEntry',
    description: 'Allow duplicate fetch-offer requests to be skipped once replay has already moved into the post-fetch branch for the same context, or when redirection already returned NOT_REQUIRED for that journey.',
    optionalAfterSeconds: 5,
    requirePriorProcessedOccurrence: true,
    allowObservedBranchAdvance: false,
    requireBranchAdvance: true,
    advanceWhenSeenLogTags: [
      'POLLING API :: LINE_STATUS_REQUEST',
      'FETCH_OFFER_ASYNC_RESPONSE_REQUEST',
      'CALCULATE_EMI_REQUEST',
      'PROFILE_INGESTION_REQUEST'
    ],
    skipWhenPriorProcessedEntries: [
      {
        logTag: 'FlipKart-GetRedirectionURL_RESPONSE',
        payloadPath: 'status',
        equals: 'NOT_REQUIRED'
      }
    ]
  },
  {
    logTag: 'FETCH_OFFER_ASYNC_RESPONSE_REQUEST',
    handler: 'maybeSkipOptionalRepeatedEntry',
    description: 'Allow repeated fetch-offer async callbacks to be skipped for the same journey context; branch-advance observations can also trigger the skip earlier.',
    optionalAfterSeconds: 5,
    requirePriorProcessedOccurrence: true,
    requireBranchAdvance: false,
    advanceWhenSeenLogTags: [
      'CHECK ELIGIBILITY STATUS API_REQUEST',
      'FlipKart-HardEligibilityStatus_REQUEST'
    ]
  },
  {
    logTag: 'LSP-GetKFS_REQUEST',
    handler: 'maybeSkipOptionalRepeatedEntry',
    description: 'Allow duplicate KFS gateway requests to be skipped once replay has already advanced into the post-KFS branch for the same context.',
    optionalAfterSeconds: 5,
    requirePriorProcessedOccurrence: true,
    advanceWhenSeenLogTags: [
      'FETCH_OFFER_ASYNC_RESPONSE_REQUEST',
      'LSP-FetchOfferRequest_REQUEST',
      'FlipKart-GetKFS_RESPONSE'
    ]
  },
  {
    logTag: 'CHECK ELIGIBILITY STATUS API_REQUEST',
    handler: 'maybeSkipOptionalRepeatedEntry',
    description: 'Allow repeated hard-eligibility status polls to be skipped when replay has already advanced into the corresponding status response branch.',
    optionalAfterSeconds: 5,
    requirePriorProcessedOccurrence: true,
    advanceWhenSeenLogTags: [
      'FlipKart-HardEligibilityStatus_REQUEST',
      'FlipKart-HardEligibilityStatus_RESPONSE'
    ]
  },
  {
    logTag: 'HARD_ELIGIBILITY_REQUEST',
    handler: 'maybeSkipOptionalRepeatedEntry',
    description: 'Allow repeated hard-eligibility lender calls to be skipped when replay already advanced into profile-ingestion or fetch-offer steps for the same context.',
    optionalAfterSeconds: 5,
    requirePriorProcessedOccurrence: true,
    advanceWhenSeenLogTags: [
      'PROFILE_INGESTION_REQUEST',
      'LSP-FetchOfferRequest_REQUEST',
      'FlipKart-HardEligibility_RESPONSE'
    ]
  },
  {
    logTag: 'ProcessStatus_REQUEST',
    handler: 'maybeSkipOptionalRepeatedEntry',
    description: 'Allow process-status polling to be skipped when the live journey has already completed the loan-processing redirection branch.',
    optionalAfterSeconds: 5,
    requirePriorProcessedOccurrence: false,
    skipWhenPriorProcessedLogTags: [
      'FlipKart-GetRedirectionURL_REQUEST',
      'FlipKart-GetRedirectionURL_RESPONSE'
    ]
  }
];

export const POLLING_API_LOG_TAGS = new Set([
  'LSP-LoanStatus_REQUEST',
  'FlipKart-GetRedirectionURL_REQUEST'
]);

export const SKIPPABLE_ASYNC_API_LOG_TAGS = new Set([
  'FETCH_OFFER_ASYNC_RESPONSE_REQUEST'
]);

export const THEMIS_ELIGIBILITY_LOG_TAG = 'Themis-Eligibility_REQUEST';
export const THEMIS_KFS_LOG_TAG = 'Themis-KFS_REQUEST';

export function isThemisEligibilitySpecialCase(logTag) {
  return logTag === THEMIS_ELIGIBILITY_LOG_TAG;
}

export function isThemisKfsSpecialCase(logTag) {
  return logTag === THEMIS_KFS_LOG_TAG;
}

export function isPollingApiLogTag(logTag) {
  return POLLING_API_LOG_TAGS.has(logTag);
}

export function isSkippableAsyncApiLogTag(logTag) {
  return SKIPPABLE_ASYNC_API_LOG_TAGS.has(logTag);
}

export function getOptionalRepeatPolicy(config, currentEntry) {
  if (!currentEntry?.isRequest) {
    return null;
  }

  const builtInSpecialCase = REPLAY_SPECIAL_CASES.find(
    specialCase => specialCase.logTag === currentEntry.logTag && specialCase.handler === 'maybeSkipOptionalRepeatedEntry'
  );

  const optionalTags = config?.OPTIONAL_REPEAT_LOG_TAGS || [];
  const envEnabled = optionalTags.includes(currentEntry.logTag);

  if (!builtInSpecialCase && !envEnabled) {
    return null;
  }

  return {
    logTag: currentEntry.logTag,
    optionalAfterSeconds:
      builtInSpecialCase?.optionalAfterSeconds ??
      config?.OPTIONAL_REPEAT_AFTER_SECONDS ??
      5,
    requirePriorProcessedOccurrence:
      builtInSpecialCase?.requirePriorProcessedOccurrence ?? true,
    allowObservedBranchAdvance:
      builtInSpecialCase?.allowObservedBranchAdvance ?? true,
    requireBranchAdvance:
      builtInSpecialCase?.requireBranchAdvance ?? false,
    advanceWhenSeenLogTags: builtInSpecialCase?.advanceWhenSeenLogTags || [],
    skipWhenPriorProcessedLogTags: builtInSpecialCase?.skipWhenPriorProcessedLogTags || [],
    skipWhenPriorProcessedEntries: builtInSpecialCase?.skipWhenPriorProcessedEntries || []
  };
}
