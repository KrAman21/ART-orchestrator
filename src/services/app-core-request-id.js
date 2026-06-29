import crypto from 'crypto';

const LSP_REQUEST_ID_PREFIX = 'LSP';
const LSP_REQUEST_ID_TOTAL_LENGTH = 35;
const APP_CORE_REQUEST_ID_REUSE_MAP = Object.freeze({
  'LSP-GetAgreementDataStatus_REQUEST': 'GetAgreementDataRequest_REQUEST'
});

function buildLspStyleRequestId() {
  return `${LSP_REQUEST_ID_PREFIX}${crypto.randomUUID().replaceAll('-', '')}`;
}

function isValidLspStyleRequestId(value) {
  return (
    typeof value === 'string' &&
    value.length === LSP_REQUEST_ID_TOTAL_LENGTH &&
    value.startsWith(LSP_REQUEST_ID_PREFIX)
  );
}

export function getAppCoreRequestId(entry) {
  const originalRequestId = entry?.requestId || null;

  if (!entry || entry.sourceDestination !== 'APP_CORE') {
    return {
      requestId: originalRequestId,
      originalRequestId,
      normalized: false,
      reusedFromLogTag: null
    };
  }

  const reusedTriggerLogTag = APP_CORE_REQUEST_ID_REUSE_MAP[entry.logTag] || null;
  const replayRequestIdLookup =
    reusedTriggerLogTag && typeof entry?.stateManager?.getReplayRequestIdForLogTag === 'function'
      ? entry.stateManager.getReplayRequestIdForLogTag(reusedTriggerLogTag)
      : null;

  if (isValidLspStyleRequestId(replayRequestIdLookup)) {
    return {
      requestId: replayRequestIdLookup,
      originalRequestId,
      normalized: false,
      reusedFromLogTag: reusedTriggerLogTag
    };
  }

  if (isValidLspStyleRequestId(originalRequestId)) {
    return {
      requestId: originalRequestId,
      originalRequestId,
      normalized: false,
      reusedFromLogTag: null
    };
  }

  return {
    requestId: buildLspStyleRequestId(),
    originalRequestId,
    normalized: true,
    reusedFromLogTag: null
  };
}
