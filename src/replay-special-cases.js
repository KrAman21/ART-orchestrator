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
    advanceWhenSeenLogTags: [
      'CREATE APPLICATION API_REQUEST',
      'FETCH_OFFER_ASYNC_RESPONSE_REQUEST'
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
  const optionalTags = config?.OPTIONAL_REPEAT_LOG_TAGS || [];
  const optionalAfterSeconds = config?.OPTIONAL_REPEAT_AFTER_SECONDS || 5;

  if (!currentEntry?.isRequest) {
    return null;
  }

  if (!optionalTags.includes(currentEntry.logTag)) {
    return null;
  }

  return {
    logTag: currentEntry.logTag,
    optionalAfterSeconds,
    advanceWhenSeenLogTags: REPLAY_SPECIAL_CASES.find(
      specialCase => specialCase.logTag === currentEntry.logTag
    )?.advanceWhenSeenLogTags || []
  };
}
