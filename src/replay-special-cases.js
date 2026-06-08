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
  },
  {
    logTag: 'LenderLineStatus_REQUEST',
    handler: 'triggerGatewayCall',
    description:
      'LenderLineStatus_REQUEST (CORE→GATEWAY) is no longer initiated by LSP in the new code path for standard checkout flows. ' +
      'ART triggers the call to /gateway/v1.0/lineStatus itself after a short wait, ' +
      'unless the preceding logs indicate a Refund or FetchLineStatus journey (in which case LSP will make the call as before).',
    triggerAfterSeconds: 2,
    endpoint: '/gateway/v1.0/lineStatus',
    // If any of these logTags appear in the preceding processed entries for this
    // order, LSP will invoke LenderLineStatus itself — do NOT trigger from ART.
    skipIfPrecedingLogTags: [
      'FlipKart-Refund',
      'FlipKart-LineOnboarding-FetchLineStatus_REQUEST'
    ]
  },
  {
    logTag: 'GENERATE PARTNER AUTH TOKEN_REQUEST',
    handler: 'skipAfterTimeoutFallback',
    description: 'If the gateway does not send the GENERATE PARTNER AUTH TOKEN call to ART within 4s, skip the req/resp pair — the auth token is likely already cached. If the request does arrive within 4s it is served normally from prod logs.',
    optionalAfterSeconds: 4
  }
];

export const THEMIS_ELIGIBILITY_LOG_TAG = 'Themis-Eligibility_REQUEST';
export const THEMIS_KFS_LOG_TAG = 'Themis-KFS_REQUEST';

export function isThemisEligibilitySpecialCase(logTag) {
  return logTag === THEMIS_ELIGIBILITY_LOG_TAG;
}

export function isThemisKfsSpecialCase(logTag) {
  return logTag === THEMIS_KFS_LOG_TAG;
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
