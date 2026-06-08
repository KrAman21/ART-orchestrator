import { writeFileSync, mkdirSync } from 'fs';
import { resolve, dirname, basename } from 'path';

/**
 * Generates a self-contained HTML report from the ART JSON report.
 * The HTML is written next to the JSON report with a .html extension.
 *
 * @param {object} report - The ART report object.
 * @param {string} jsonReportPath - Absolute path to the JSON report file.
 * @returns {string} Absolute path to the generated HTML file.
 */
export function generateHtmlReport(report, jsonReportPath) {
  const htmlPath = resolve(
    dirname(jsonReportPath),
    basename(jsonReportPath, '.json') + '.html'
  );

  const html = buildHtml(report);
  mkdirSync(dirname(htmlPath), { recursive: true });
  writeFileSync(htmlPath, html, 'utf-8');
  return htmlPath;
}

// ─── helpers ────────────────────────────────────────────────────────────────

function esc(str) {
  if (str === null || str === undefined) return '';
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function jsonPreview(value) {
  if (value === null || value === undefined) return '<em class="null-val">null</em>';
  if (value === '<missing>') return '<em class="missing-val">&lt;missing&gt;</em>';
  if (typeof value !== 'object') return `<span class="scalar-val">${esc(String(value))}</span>`;
  const json = JSON.stringify(value, null, 2);
  const id = `json-${Math.random().toString(36).slice(2)}`;
  return `<details class="json-tree"><summary class="json-summary">{ … } <span class="json-toggle">expand</span></summary><pre class="json-block" id="${id}">${esc(json)}</pre></details>`;
}

function reasonBadge(reason) {
  const map = {
    'value mismatch': 'badge-mismatch',
    'type mismatch': 'badge-type',
    'key missing in actual': 'badge-missing',
    'extra key in actual': 'badge-extra',
    'element missing in actual': 'badge-missing',
    'extra element in actual': 'badge-extra',
    'expected missing, actual present': 'badge-extra',
    'expected present, actual missing': 'badge-missing',
  };
  const cls = map[reason] || 'badge-other';
  return `<span class="badge ${cls}">${esc(reason)}</span>`;
}

// ─── section builders ────────────────────────────────────────────────────────

/**
 * Groups comparisons by logTag, merging multiple entries with the same tag
 * (deduplicated by their difference set so genuinely distinct variants are
 * kept as separate sub-entries).
 */
function groupByTag(comparisons) {
  const tagMap = new Map();
  for (const comp of comparisons) {
    const tag = comp.logTag || 'unknown';
    if (!tagMap.has(tag)) tagMap.set(tag, []);
    tagMap.get(tag).push(comp);
  }
  return tagMap;
}

function buildDiffTable(differences) {
  if (!differences || differences.length === 0) return '<p class="no-diff">✅ No differences</p>';

  const rows = differences.map(diff => {
    const typeCols = (diff.expectedType || diff.actualType)
      ? `<td class="type-cell">${esc(diff.expectedType || '')}</td><td class="type-cell">${esc(diff.actualType || '')}</td>`
      : '<td colspan="2" class="type-cell dimmed">—</td>';

    return `<tr>
      <td class="path-cell"><code>${esc(diff.path || 'root')}</code></td>
      <td class="reason-cell">${reasonBadge(diff.reason)}</td>
      <td class="val-cell expected-col">${jsonPreview(diff.expected)}</td>
      <td class="val-cell actual-col">${jsonPreview(diff.actual)}</td>
      ${typeCols}
    </tr>`;
  }).join('\n');

  return `<div class="table-wrap"><table class="diff-table">
    <thead>
      <tr>
        <th>Path / Key</th>
        <th>Status</th>
        <th class="expected-col">Expected</th>
        <th class="actual-col">Actual</th>
        <th>Exp. Type</th>
        <th>Act. Type</th>
      </tr>
    </thead>
    <tbody>${rows}</tbody>
  </table></div>`;
}

function buildTagSection(tag, comps, tagIndex) {
  const totalDiffs = comps.reduce((s, c) => s + (c.differenceCount || 0), 0);
  const hasIssue = totalDiffs > 0;
  const statusIcon = hasIssue ? '❌' : '✅';
  const statusClass = hasIssue ? 'tag-fail' : 'tag-pass';
  const sectionId = `tag-${tagIndex}`;

  const innerParts = comps.map((comp, ci) => {
    const entryLabel = comp.entry
      ? `<span class="entry-label">${esc(comp.entry)}</span>`
      : '';
    const ts = comp.timestamp
      ? `<span class="ts">${esc(new Date(comp.timestamp).toLocaleTimeString())}</span>`
      : '';

    const diffCount = comp.differenceCount || 0;
    const label = diffCount > 0
      ? `<span class="diff-badge">${diffCount} diff${diffCount !== 1 ? 's' : ''}</span>`
      : '<span class="diff-badge zero">0 diffs</span>';

    // If this tag has multiple comparison entries, wrap each in its own sub-details
    if (comps.length > 1) {
      return `<details class="comp-entry" ${ci === 0 && diffCount > 0 ? 'open' : ''}>
        <summary class="comp-entry-summary">${entryLabel} ${ts} ${label}</summary>
        ${buildDiffTable(comp.differences)}
      </details>`;
    }
    return buildDiffTable(comp.differences);
  }).join('\n');

  return `<details class="tag-section ${statusClass}" id="${sectionId}">
    <summary class="tag-summary">
      <span class="tag-icon">${statusIcon}</span>
      <span class="tag-name">${esc(tag)}</span>
      <span class="tag-meta">${comps.length} entr${comps.length !== 1 ? 'ies' : 'y'} · <strong>${totalDiffs}</strong> difference${totalDiffs !== 1 ? 's' : ''}</span>
    </summary>
    <div class="tag-body">${innerParts}</div>
  </details>`;
}

function buildOrderSection(orderComp, orderOutcome) {
  const orderId = orderComp.orderId;
  const comps = orderComp.comparisons || [];

  const tagMap = groupByTag(comps);
  const totalTags = tagMap.size;
  const mismatchedTags = [...tagMap.values()].filter(entries =>
    entries.some(e => (e.differenceCount || 0) > 0)
  ).length;
  const matchedTags = totalTags - mismatchedTags;
  const totalDiffs = comps.reduce((s, c) => s + (c.differenceCount || 0), 0);

  const statusColor = orderComp.status === 'COMPLETED' ? 'status-ok' : 'status-fail';
  const failInfo = orderOutcome
    ? `<div class="failure-banner">⚠️ Failed at <code>${esc(orderOutcome.logTag)}</code>: <strong>${esc(orderOutcome.failureReason)}</strong></div>`
    : '';

  const tagSections = [...tagMap.entries()]
    .map(([tag, entries], i) => buildTagSection(tag, entries, `${orderId}-${i}`))
    .join('\n');

  return `<section class="order-section">
    <h2 class="order-title">
      <span class="order-id">${esc(orderId)}</span>
      <span class="order-status ${statusColor}">${esc(orderComp.status)}</span>
    </h2>
    ${failInfo}
    <div class="summary-pills">
      <span class="pill pill-total">📋 ${totalTags} API tags</span>
      <span class="pill pill-ok">✅ ${matchedTags} matched</span>
      <span class="pill pill-fail">❌ ${mismatchedTags} mismatched</span>
      <span class="pill pill-diff">🔍 ${totalDiffs} total diffs</span>
    </div>
    <div class="tag-list">${tagSections || '<p class="no-diff">No payload comparisons recorded.</p>'}</div>
  </section>`;
}

function buildRequestSection(reqDetail) {
  if (!reqDetail || !reqDetail.requests || reqDetail.requests.length === 0) return '';

  const rows = reqDetail.requests.map(req => {
    const statusCls = (req.httpStatus && req.httpStatus >= 400) ? 'http-err' : '';
    return `<tr>
      <td>${esc(req.logTag)}</td>
      <td>${esc(req.endpoint)}</td>
      <td class="${statusCls}">${esc(req.httpStatus ?? '—')}</td>
      <td class="err-msg">${esc(req.errorMessage || '—')}</td>
      <td>${jsonPreview(req.requestPayload)}</td>
      <td>${jsonPreview(typeof req.responseData === 'string' ? (() => { try { return JSON.parse(req.responseData); } catch { return req.responseData; } })() : req.responseData)}</td>
    </tr>`;
  }).join('\n');

  return `<details class="req-section">
    <summary class="req-summary">🔎 Buffer / API Failures for <code>${esc(reqDetail.orderId)}</code> (${reqDetail.requests.length})</summary>
    <div class="table-wrap"><table class="req-table">
      <thead><tr><th>Log Tag</th><th>Endpoint</th><th>HTTP</th><th>Error</th><th>Request</th><th>Response</th></tr></thead>
      <tbody>${rows}</tbody>
    </table></div>
  </details>`;
}

// ─── main HTML builder ───────────────────────────────────────────────────────

function buildHtml(report) {
  const summary = report.summary || {};
  const overallOk = report.overallStatus === 'SUCCESS';
  const statusColor = overallOk ? '#22c55e' : '#ef4444';
  const statusLabel = esc(report.overallStatus || 'UNKNOWN');

  const execId = esc(report.executionId || '—');
  const startTime = report.executionStartTime
    ? new Date(report.executionStartTime).toLocaleString()
    : '—';
  const duration = report.totalDuration != null
    ? `${(report.totalDuration / 1000).toFixed(1)}s`
    : '—';

  // Merge outcome map for quick lookup
  const outcomeMap = new Map((report.orderOutcomes || []).map(o => [o.orderId, o]));

  const orderSections = (report.payloadComparisons || [])
    .map(orderComp => buildOrderSection(orderComp, outcomeMap.get(orderComp.orderId)))
    .join('\n');

  const requestSections = (report.requestDetails || [])
    .map(buildRequestSection)
    .join('\n');

  // Orders with no payload comparisons (e.g. failed very early)
  const comparedIds = new Set((report.payloadComparisons || []).map(o => o.orderId));
  const uncoveredOutcomes = (report.orderOutcomes || []).filter(o => !comparedIds.has(o.orderId));
  const uncoveredHtml = uncoveredOutcomes.length > 0
    ? `<section class="order-section uncovered">
        <h2 class="order-title">Orders with no comparison data</h2>
        <ul>${uncoveredOutcomes.map(o =>
          `<li><code>${esc(o.orderId)}</code> — <span class="status-fail">${esc(o.status)}</span>: ${esc(o.failureReason || o.stopReason || '')}</li>`
        ).join('')}</ul>
      </section>`
    : '';

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8" />
<meta name="viewport" content="width=device-width, initial-scale=1.0" />
<title>ART Report — ${execId}</title>
<style>
  /* ── reset & base ── */
  *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }
  body { font-family: 'Segoe UI', system-ui, -apple-system, sans-serif; background: #0f172a; color: #e2e8f0; line-height: 1.5; padding: 24px; }
  a { color: #60a5fa; }

  /* ── layout ── */
  .container { max-width: 1280px; margin: 0 auto; }
  h1 { font-size: 1.6rem; margin-bottom: 4px; }
  h2.order-title { font-size: 1.15rem; display: flex; align-items: center; gap: 10px; margin-bottom: 12px; }
  .meta { font-size: 0.8rem; color: #94a3b8; margin-bottom: 24px; }

  /* ── header ── */
  .report-header { background: #1e293b; border-radius: 12px; padding: 20px 24px; margin-bottom: 24px; border-left: 5px solid ${statusColor}; }
  .overall-status { font-size: 1.3rem; font-weight: 700; color: ${statusColor}; margin-bottom: 8px; }

  /* ── global summary ── */
  .global-pills { display: flex; flex-wrap: wrap; gap: 10px; margin-bottom: 24px; }
  .g-pill { background: #1e293b; border-radius: 8px; padding: 8px 16px; font-size: 0.85rem; font-weight: 600; border: 1px solid #334155; }
  .g-pill.ok { border-color: #22c55e; color: #22c55e; }
  .g-pill.fail { border-color: #ef4444; color: #ef4444; }
  .g-pill.warn { border-color: #f59e0b; color: #f59e0b; }
  .g-pill.info { border-color: #60a5fa; color: #60a5fa; }

  /* ── section cards ── */
  .order-section { background: #1e293b; border-radius: 10px; padding: 20px 24px; margin-bottom: 20px; }
  .order-section.uncovered { border: 1px dashed #475569; }
  .order-id { font-family: monospace; color: #93c5fd; }
  .order-status { font-size: 0.75rem; padding: 2px 10px; border-radius: 999px; font-weight: 700; }
  .status-ok { background: #14532d; color: #86efac; }
  .status-fail { background: #450a0a; color: #fca5a5; }
  .failure-banner { background: #1c1917; border: 1px solid #78350f; border-radius: 6px; padding: 8px 14px; margin-bottom: 14px; font-size: 0.85rem; color: #fcd34d; }

  /* ── per-order pills ── */
  .summary-pills { display: flex; flex-wrap: wrap; gap: 8px; margin-bottom: 14px; }
  .pill { font-size: 0.78rem; padding: 3px 10px; border-radius: 999px; font-weight: 600; }
  .pill-total { background: #1e3a5f; color: #93c5fd; }
  .pill-ok { background: #14532d; color: #86efac; }
  .pill-fail { background: #450a0a; color: #fca5a5; }
  .pill-diff { background: #1c1917; color: #fcd34d; }

  /* ── tag accordion ── */
  .tag-list { display: flex; flex-direction: column; gap: 8px; }
  .tag-section { border-radius: 8px; border: 1px solid #334155; overflow: hidden; }
  .tag-section.tag-fail { border-color: #7f1d1d; }
  .tag-section.tag-pass { border-color: #14532d; }
  .tag-summary { cursor: pointer; padding: 10px 16px; display: flex; align-items: center; gap: 10px; background: #0f172a; user-select: none; list-style: none; }
  .tag-summary::-webkit-details-marker { display: none; }
  .tag-section[open] .tag-summary { border-bottom: 1px solid #334155; }
  .tag-icon { font-size: 0.95rem; }
  .tag-name { font-family: monospace; font-size: 0.9rem; font-weight: 600; flex: 1; }
  .tag-meta { font-size: 0.75rem; color: #94a3b8; }
  .tag-body { padding: 14px 16px; background: #0f172a; }

  /* ── comp entry (multiple occurrences of same tag) ── */
  .comp-entry { border: 1px solid #1e293b; border-radius: 6px; margin-bottom: 8px; }
  .comp-entry-summary { cursor: pointer; padding: 6px 12px; background: #1e293b; font-size: 0.8rem; display: flex; align-items: center; gap: 8px; list-style: none; }
  .comp-entry-summary::-webkit-details-marker { display: none; }
  .entry-label { font-family: monospace; color: #a5b4fc; }
  .ts { color: #64748b; font-size: 0.75rem; }
  .diff-badge { font-size: 0.72rem; padding: 2px 7px; border-radius: 999px; background: #7f1d1d; color: #fca5a5; font-weight: 700; }
  .diff-badge.zero { background: #14532d; color: #86efac; }

  /* ── diff table ── */
  .table-wrap { overflow-x: auto; }
  .diff-table { width: 100%; border-collapse: collapse; font-size: 0.82rem; }
  .diff-table th { background: #1e293b; padding: 8px 12px; text-align: left; color: #94a3b8; font-weight: 600; border-bottom: 1px solid #334155; white-space: nowrap; }
  .diff-table td { padding: 7px 12px; vertical-align: top; border-bottom: 1px solid #1e293b; }
  .diff-table tr:last-child td { border-bottom: none; }
  .diff-table tr:hover td { background: #1e293b; }
  .path-cell code { color: #c4b5fd; font-size: 0.8rem; word-break: break-all; }
  .reason-cell { white-space: nowrap; }
  .val-cell { max-width: 320px; word-break: break-word; }
  .expected-col { color: #fda4af; }
  .actual-col { color: #86efac; }
  .type-cell { font-size: 0.75rem; color: #94a3b8; }
  .dimmed { color: #475569; }
  .no-diff { color: #4ade80; font-size: 0.85rem; padding: 8px 0; }

  /* ── badges ── */
  .badge { display: inline-block; font-size: 0.7rem; padding: 2px 8px; border-radius: 999px; font-weight: 700; }
  .badge-mismatch { background: #7c2d12; color: #fdba74; }
  .badge-type    { background: #4c1d95; color: #c4b5fd; }
  .badge-missing { background: #7f1d1d; color: #fca5a5; }
  .badge-extra   { background: #1e3a5f; color: #93c5fd; }
  .badge-other   { background: #1c1917; color: #d6d3d1; }

  /* ── JSON tree ── */
  .json-tree { display: inline; }
  .json-summary { cursor: pointer; color: #f59e0b; font-size: 0.78rem; display: inline; list-style: none; }
  .json-summary::-webkit-details-marker { display: none; }
  .json-toggle { font-size: 0.65rem; color: #64748b; }
  .json-block { white-space: pre-wrap; background: #1e293b; border-radius: 6px; padding: 8px; font-size: 0.75rem; color: #a5f3fc; margin-top: 4px; max-height: 300px; overflow-y: auto; }

  /* ── scalar / null ── */
  .scalar-val { font-family: monospace; }
  .null-val { color: #64748b; font-style: italic; }
  .missing-val { color: #f87171; font-style: italic; }

  /* ── request section ── */
  .req-section { border: 1px solid #334155; border-radius: 8px; margin-bottom: 12px; }
  .req-summary { cursor: pointer; padding: 10px 16px; background: #1e293b; border-radius: 8px; list-style: none; font-size: 0.85rem; }
  .req-summary::-webkit-details-marker { display: none; }
  .req-table { width: 100%; border-collapse: collapse; font-size: 0.8rem; }
  .req-table th { background: #1e293b; padding: 7px 10px; text-align: left; color: #94a3b8; border-bottom: 1px solid #334155; }
  .req-table td { padding: 7px 10px; vertical-align: top; border-bottom: 1px solid #1e293b; }
  .http-err { color: #f87171; font-weight: 700; }
  .err-msg { color: #fca5a5; max-width: 240px; }

  /* ── separator ── */
  .section-title { font-size: 1rem; font-weight: 700; color: #94a3b8; margin: 28px 0 10px; text-transform: uppercase; letter-spacing: 0.05em; }
  hr.divider { border: none; border-top: 1px solid #1e293b; margin: 24px 0; }
</style>
</head>
<body>
<div class="container">

  <!-- Header -->
  <div class="report-header">
    <div class="overall-status">${overallOk ? '🟢' : '🔴'} ${statusLabel}</div>
    <h1>ART Comparison Report</h1>
    <div class="meta">
      Execution ID: <strong>${execId}</strong> &nbsp;·&nbsp;
      Started: <strong>${esc(startTime)}</strong> &nbsp;·&nbsp;
      Duration: <strong>${esc(duration)}</strong>
    </div>
  </div>

  <!-- Global summary pills -->
  <div class="global-pills">
    <span class="g-pill info">📋 ${summary.totalOrders ?? 0} orders</span>
    <span class="g-pill ok">✅ ${summary.completed ?? 0} passed</span>
    <span class="g-pill fail">❌ ${summary.failed ?? 0} failed</span>
    ${(summary.stuck ?? 0) > 0 ? `<span class="g-pill warn">🟡 ${summary.stuck} stuck</span>` : ''}
    ${(summary.timeout ?? 0) > 0 ? `<span class="g-pill warn">⏱ ${summary.timeout} timeout</span>` : ''}
    ${(summary.skipped ?? 0) > 0 ? `<span class="g-pill info">⏭ ${summary.skipped} skipped</span>` : ''}
    <span class="g-pill info">🔍 ${summary.totalPayloadComparisons ?? 0} comparisons</span>
    <span class="g-pill ${(summary.totalPayloadMismatches ?? 0) > 0 ? 'fail' : 'ok'}">⚠️ ${summary.totalPayloadMismatches ?? 0} mismatches</span>
    ${(summary.totalBufferFailures ?? 0) > 0 ? `<span class="g-pill warn">🔴 ${summary.totalBufferFailures} buffer failures</span>` : ''}
  </div>

  <!-- API Payload Comparisons per order -->
  ${orderSections || '<p class="no-diff">No payload comparison data available.</p>'}

  <!-- Uncovered orders -->
  ${uncoveredHtml}

  <!-- Buffer / API failure details -->
  ${requestSections ? `<hr class="divider"><p class="section-title">API / Buffer Failure Details</p>${requestSections}` : ''}

</div>
</body>
</html>`;
}

export default generateHtmlReport;
