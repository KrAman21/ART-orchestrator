function readUrlCandidate(value) {
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

export function extractTraceLogUrl(rawLog = {}) {
  const message = rawLog.message || {};
  const candidates = [
    rawLog.url,
    rawLog.trace_log?.url,
    rawLog.traceLog?.url,
    message.url,
    message.trace_log?.url,
    message.traceLog?.url,
    message.trace_request?.url
  ];

  for (const candidate of candidates) {
    const url = readUrlCandidate(candidate);
    if (url) {
      return url;
    }
  }

  return null;
}

export function extractTraceLogMethod(rawLog = {}) {
  const message = rawLog.message || {};
  const candidates = [
    rawLog.method,
    rawLog.http_method,
    rawLog.trace_log?.method,
    rawLog.traceLog?.method,
    message.method,
    message.http_method,
    message.trace_log?.method,
    message.traceLog?.method
  ];

  for (const candidate of candidates) {
    if (typeof candidate === 'string' && candidate.trim()) {
      return candidate.trim().toUpperCase();
    }
  }

  return null;
}

export function isAbsoluteUrl(value) {
  return typeof value === 'string' && /^https?:\/\//i.test(value);
}

export function resolveReplayEndpoint(url) {
  if (!url || typeof url !== 'string') {
    return null;
  }

  const normalizedUrl = url.trim();
  if (!normalizedUrl) {
    return null;
  }

  if (isAbsoluteUrl(normalizedUrl)) {
    const parsed = new URL(normalizedUrl);
    return `${parsed.pathname}${parsed.search}`;
  }

  if (normalizedUrl.startsWith('/')) {
    return normalizedUrl;
  }

  return `/${normalizedUrl}`;
}
