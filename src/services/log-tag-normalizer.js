// Alias map: treat these logTag bases as equivalent for matching purposes.
// Key = incoming/live tag base, Value = canonical/prod tag base.
const LOG_TAG_ALIASES = {
  'GET_CHECKOUT_STATUS_FO': 'GET_CHECKOUT_STATUS_LS',
  'GET_CHECKOUT_STATUS_LINE_STATUS': 'GET_CHECKOUT_STATUS_LS',
};

function applyTagAlias(tag) {
  if (!tag) return tag;
  for (const [from, to] of Object.entries(LOG_TAG_ALIASES)) {
    if (tag.startsWith(from)) {
      return tag.replace(from, to);
    }
  }
  return tag;
}

export function canonicalRequestLogTag(logTag) {
  if (!logTag || typeof logTag !== 'string') {
    return logTag;
  }

  const normalized = logTag
    .trim()
    .replace(/_OUTGOING$/i, '_REQUEST')
    .replace(/_INCOMING$/i, '_REQUEST');

  return applyTagAlias(normalized);
}

export function canonicalResponseLogTag(logTag) {
  if (!logTag || typeof logTag !== 'string') {
    return logTag;
  }

  const normalized = logTag
    .trim()
    .replace(/_OUTGOING$/i, '_RESPONSE')
    .replace(/_INCOMING$/i, '_RESPONSE');

  return applyTagAlias(normalized);
}
