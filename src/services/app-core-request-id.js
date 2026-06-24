import crypto from 'crypto';

const LSP_REQUEST_ID_PREFIX = 'LSP';
const LSP_REQUEST_ID_TOTAL_LENGTH = 35;

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
      normalized: false
    };
  }

  if (isValidLspStyleRequestId(originalRequestId)) {
    return {
      requestId: originalRequestId,
      originalRequestId,
      normalized: false
    };
  }

  return {
    requestId: buildLspStyleRequestId(),
    originalRequestId,
    normalized: true
  };
}
