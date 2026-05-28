export function canonicalRequestLogTag(logTag) {
  if (!logTag || typeof logTag !== 'string') {
    return logTag;
  }

  return logTag
    .trim()
    .replace(/_OUTGOING$/i, '_REQUEST')
    .replace(/_INCOMING$/i, '_REQUEST');
}

export function canonicalResponseLogTag(logTag) {
  if (!logTag || typeof logTag !== 'string') {
    return logTag;
  }

  return logTag
    .trim()
    .replace(/_OUTGOING$/i, '_RESPONSE')
    .replace(/_INCOMING$/i, '_RESPONSE');
}
