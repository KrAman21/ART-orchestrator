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
    description: 'Allow repeated fetch-offer requests to be skipped once the same replay branch has already advanced into async fetch-offer handling.',
    optionalAfterSeconds: 5,
    requirePriorProcessedOccurrence: true,
    advanceWhenSeenLogTags: [
      'FETCH_OFFER_ASYNC_RESPONSE_REQUEST'
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
    advanceWhenSeenLogTags: builtInSpecialCase?.advanceWhenSeenLogTags || [],
    skipWhenPriorProcessedLogTags: builtInSpecialCase?.skipWhenPriorProcessedLogTags || []
  };
}
