import { performance } from 'perf_hooks';

function roundMs(value) {
  return Math.round((value + Number.EPSILON) * 100) / 100;
}

function percentile(sortedValues, percentileValue) {
  if (sortedValues.length === 0) {
    return 0;
  }

  const index = Math.ceil((percentileValue / 100) * sortedValues.length) - 1;
  return sortedValues[Math.max(0, Math.min(sortedValues.length - 1, index))];
}

export class OrderProfiler {
  constructor({ enabled = false, orderId = null, merchantId = null } = {}) {
    this.enabled = enabled === true;
    this.orderId = orderId;
    this.merchantId = merchantId;
    this.startedAt = this.enabled ? performance.now() : 0;
    this.sections = new Map();
    this.lspCalls = [];
    this.downstreamCalls = [];
  }

  now() {
    return performance.now();
  }

  recordSection(name, durationMs, details = {}) {
    if (!this.enabled || !name || !Number.isFinite(durationMs)) {
      return;
    }

    const current = this.sections.get(name) || {
      name,
      totalMs: 0,
      count: 0,
      minMs: null,
      maxMs: 0,
      details: []
    };

    current.totalMs += durationMs;
    current.count += 1;
    current.minMs = current.minMs === null ? durationMs : Math.min(current.minMs, durationMs);
    current.maxMs = Math.max(current.maxMs, durationMs);

    if (Object.keys(details).length > 0) {
      current.details.push({
        durationMs: roundMs(durationMs),
        ...details
      });
    }

    this.sections.set(name, current);
  }

  endSection(name, startedAt, details = {}) {
    if (!this.enabled || !Number.isFinite(startedAt)) {
      return;
    }

    this.recordSection(name, this.now() - startedAt, details);
  }

  async measure(name, fn, details = {}) {
    if (!this.enabled) {
      return await fn();
    }

    const startedAt = this.now();
    try {
      return await fn();
    } finally {
      this.endSection(name, startedAt, details);
    }
  }

  recordDownstreamCall(callInfo) {
    if (!this.enabled || !callInfo || !Number.isFinite(callInfo.durationMs)) {
      return;
    }

    const entry = {
      destination: callInfo.destination || null,
      endpoint: callInfo.endpoint || null,
      logTag: callInfo.logTag || null,
      logIndex: callInfo.logIndex ?? null,
      requestId: callInfo.requestId || null,
      status: callInfo.status ?? null,
      success: callInfo.success === true,
      durationMs: roundMs(callInfo.durationMs)
    };

    this.downstreamCalls.push(entry);

    if (entry.destination === 'LSP') {
      this.lspCalls.push(entry);
      this.recordSection('lsp_server_latency', callInfo.durationMs, {
        endpoint: entry.endpoint,
        logTag: entry.logTag,
        logIndex: entry.logIndex,
        status: entry.status,
        success: entry.success
      });
    }
  }

  buildLatencySummary(calls) {
    const values = calls.map(call => call.durationMs).filter(Number.isFinite).sort((a, b) => a - b);
    const totalMs = values.reduce((sum, value) => sum + value, 0);

    return {
      totalMs: roundMs(totalMs),
      count: values.length,
      minMs: values.length ? roundMs(values[0]) : 0,
      maxMs: values.length ? roundMs(values[values.length - 1]) : 0,
      avgMs: values.length ? roundMs(totalMs / values.length) : 0,
      p95Ms: roundMs(percentile(values, 95))
    };
  }

  snapshot() {
    if (!this.enabled) {
      return null;
    }

    const sections = Array.from(this.sections.values()).map(section => ({
      name: section.name,
      totalMs: roundMs(section.totalMs),
      count: section.count,
      minMs: roundMs(section.minMs || 0),
      maxMs: roundMs(section.maxMs || 0),
      avgMs: roundMs(section.count ? section.totalMs / section.count : 0),
      details: section.details
    }));

    const waitSectionNames = new Set([
      'prefetch_wait',
      'inline_fetch_retry_wait',
      'external_lender_callback_wait',
      'replay_poll_sleep'
    ]);
    const totalWaitMs = sections
      .filter(section => waitSectionNames.has(section.name))
      .reduce((sum, section) => sum + section.totalMs, 0);

    return {
      enabled: true,
      orderId: this.orderId,
      merchantId: this.merchantId,
      totalProfiledMs: roundMs(this.now() - this.startedAt),
      totalWaitMs: roundMs(totalWaitMs),
      totalLspServerLatencyMs: this.buildLatencySummary(this.lspCalls).totalMs,
      sections,
      lspServerLatency: this.buildLatencySummary(this.lspCalls),
      downstreamLatency: this.buildLatencySummary(this.downstreamCalls),
      lspCalls: this.lspCalls,
      downstreamCalls: this.downstreamCalls
    };
  }
}

export function createOrderProfiler(options = {}) {
  return new OrderProfiler(options);
}
