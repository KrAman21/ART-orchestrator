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
    ? `<div class="failure-banner"><span class="failure-label">Stopped at</span><code>${esc(orderOutcome.logTag)}</code><span class="failure-reason">${esc(orderOutcome.failureReason)}</span></div>`
    : '';

  const tagSections = [...tagMap.entries()]
    .map(([tag, entries], i) => buildTagSection(tag, entries, `${orderId}-${i}`))
    .join('\n');

  return `<section class="order-section">
    <div class="order-head">
      <h2 class="order-title">
        <span class="order-id">${esc(orderId)}</span>
        <span class="order-status ${statusColor}">${esc(orderComp.status)}</span>
      </h2>
      <div class="order-subtitle">Payload comparison summary</div>
    </div>
    ${failInfo}
    <div class="summary-pills">
      <span class="pill pill-total">${totalTags} API tags</span>
      <span class="pill pill-ok">${matchedTags} matched</span>
      <span class="pill pill-fail">${mismatchedTags} mismatched</span>
      <span class="pill pill-diff">${totalDiffs} total diffs</span>
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
    <summary class="req-summary">Buffer / API failures for <code>${esc(reqDetail.orderId)}</code> <span class="req-count">${reqDetail.requests.length}</span></summary>
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
  const statusColor = overallOk ? '#15803d' : '#b91c1c';
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
  body { font-family: Aptos, "Segoe UI", "Helvetica Neue", Arial, sans-serif; background: linear-gradient(180deg, #0b1220 0%, #111827 100%); color: #dbe4f0; line-height: 1.5; padding: 28px; }
  a { color: #60a5fa; }

  /* ── layout ── */
  .container { max-width: 1320px; margin: 0 auto; }
  .report-shell { display: flex; flex-direction: column; gap: 20px; }
  h1 { font-size: 2rem; margin-bottom: 4px; letter-spacing: -0.03em; color: #f8fafc; }
  h2.order-title { font-size: 1.1rem; display: flex; align-items: center; gap: 10px; margin-bottom: 4px; }
  .eyebrow { font-size: 0.74rem; text-transform: uppercase; letter-spacing: 0.14em; color: #8aa0bf; margin-bottom: 8px; font-weight: 700; }
  .meta { font-size: 0.8rem; color: #94a3b8; margin-bottom: 24px; }

  /* ── header ── */
  .report-header { background: linear-gradient(180deg, rgba(20, 29, 45, 0.96) 0%, rgba(17, 24, 39, 0.98) 100%); border-radius: 18px; padding: 24px 26px; border: 1px solid rgba(100, 116, 139, 0.22); box-shadow: 0 14px 36px rgba(0, 0, 0, 0.26); }
  .header-row { display: flex; align-items: flex-start; justify-content: space-between; gap: 18px; margin-bottom: 18px; }
  .overall-status { font-size: 0.82rem; font-weight: 700; letter-spacing: 0.08em; text-transform: uppercase; padding: 8px 12px; border-radius: 999px; border: 1px solid currentColor; }
  .overall-status.is-ok { color: #86efac; background: rgba(21, 128, 61, 0.14); }
  .overall-status.is-fail { color: #fca5a5; background: rgba(185, 28, 28, 0.14); }
  .meta-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(220px, 1fr)); gap: 12px; }
  .meta-card { background: rgba(15, 23, 42, 0.72); border: 1px solid rgba(71, 85, 105, 0.35); border-radius: 14px; padding: 14px 16px; }
  .meta-label { display: block; font-size: 0.72rem; text-transform: uppercase; letter-spacing: 0.1em; color: #93a4bb; margin-bottom: 6px; }
  .meta-value { color: #f8fafc; font-size: 0.95rem; }
  .meta-mono { font-family: "SFMono-Regular", Consolas, "Liberation Mono", Menlo, monospace; font-size: 0.82rem; word-break: break-all; }

  /* ── summary stats ── */
  .stats-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(150px, 1fr)); gap: 12px; }
  .stat-card { background: rgba(20, 29, 45, 0.86); border: 1px solid rgba(71, 85, 105, 0.28); border-radius: 14px; padding: 14px 16px; min-height: 86px; display: flex; flex-direction: column; justify-content: space-between; }
  .stat-label { font-size: 0.76rem; text-transform: uppercase; letter-spacing: 0.08em; color: #8da2bf; }
  .stat-value { font-size: 1.5rem; font-weight: 700; color: #f8fafc; letter-spacing: -0.03em; }
  .stat-ok { color: #86efac; }
  .stat-fail { color: #fca5a5; }
  .stat-warn { color: #fcd34d; }

  /* ── section cards ── */
  .order-section { background: rgba(20, 29, 45, 0.9); border-radius: 16px; padding: 22px 24px; border: 1px solid rgba(71, 85, 105, 0.28); box-shadow: 0 10px 28px rgba(0, 0, 0, 0.18); }
  .order-section.uncovered { border: 1px dashed #475569; }
  .order-head { margin-bottom: 14px; }
  .order-subtitle { font-size: 0.82rem; color: #8ea3bf; }
  .order-id { font-family: "SFMono-Regular", Consolas, "Liberation Mono", Menlo, monospace; color: #93c5fd; }
  .order-status { font-size: 0.72rem; padding: 4px 10px; border-radius: 999px; font-weight: 700; letter-spacing: 0.06em; text-transform: uppercase; }
  .status-ok { background: rgba(21, 128, 61, 0.16); color: #86efac; border: 1px solid rgba(34, 197, 94, 0.25); }
  .status-fail { background: rgba(185, 28, 28, 0.14); color: #fca5a5; border: 1px solid rgba(239, 68, 68, 0.24); }
  .failure-banner { display: flex; flex-wrap: wrap; align-items: center; gap: 10px; background: rgba(51, 31, 10, 0.42); border: 1px solid rgba(217, 119, 6, 0.34); border-radius: 10px; padding: 10px 14px; margin-bottom: 14px; font-size: 0.84rem; color: #fde68a; }
  .failure-label { font-size: 0.72rem; text-transform: uppercase; letter-spacing: 0.08em; color: #fbbf24; font-weight: 700; }
  .failure-reason { color: #f8fafc; }
  .failure-banner code { color: #fcd34d; }

  /* ── per-order pills ── */
  .summary-pills { display: flex; flex-wrap: wrap; gap: 10px; margin-bottom: 16px; }
  .pill { font-size: 0.76rem; padding: 6px 10px; border-radius: 10px; font-weight: 600; border: 1px solid transparent; background: rgba(15, 23, 42, 0.72); }
  .pill-total { color: #bfdbfe; border-color: rgba(59, 130, 246, 0.22); }
  .pill-ok { color: #86efac; border-color: rgba(34, 197, 94, 0.22); }
  .pill-fail { color: #fca5a5; border-color: rgba(239, 68, 68, 0.22); }
  .pill-diff { color: #fde68a; border-color: rgba(245, 158, 11, 0.22); }

  /* ── tag accordion ── */
  .tag-list { display: flex; flex-direction: column; gap: 8px; }
  .tag-section { border-radius: 12px; border: 1px solid rgba(71, 85, 105, 0.34); overflow: hidden; background: rgba(9, 14, 25, 0.44); }
  .tag-section.tag-fail { border-color: rgba(239, 68, 68, 0.28); }
  .tag-section.tag-pass { border-color: rgba(34, 197, 94, 0.24); }
  .tag-summary { cursor: pointer; padding: 12px 16px; display: flex; align-items: center; gap: 10px; background: rgba(10, 16, 28, 0.9); user-select: none; list-style: none; }
  .tag-summary::-webkit-details-marker { display: none; }
  .tag-section[open] .tag-summary { border-bottom: 1px solid rgba(71, 85, 105, 0.28); }
  .tag-icon { font-size: 0.88rem; }
  .tag-name { font-family: "SFMono-Regular", Consolas, "Liberation Mono", Menlo, monospace; font-size: 0.88rem; font-weight: 600; flex: 1; color: #e5eefb; }
  .tag-meta { font-size: 0.75rem; color: #8ea3bf; }
  .tag-body { padding: 14px 16px; background: rgba(10, 16, 28, 0.76); }

  /* ── comp entry (multiple occurrences of same tag) ── */
  .comp-entry { border: 1px solid rgba(51, 65, 85, 0.55); border-radius: 10px; margin-bottom: 10px; overflow: hidden; }
  .comp-entry-summary { cursor: pointer; padding: 8px 12px; background: rgba(20, 29, 45, 0.85); font-size: 0.79rem; display: flex; align-items: center; gap: 8px; list-style: none; }
  .comp-entry-summary::-webkit-details-marker { display: none; }
  .entry-label { font-family: "SFMono-Regular", Consolas, "Liberation Mono", Menlo, monospace; color: #bfdbfe; }
  .ts { color: #64748b; font-size: 0.75rem; }
  .diff-badge { font-size: 0.7rem; padding: 3px 8px; border-radius: 999px; background: rgba(185, 28, 28, 0.16); color: #fca5a5; font-weight: 700; border: 1px solid rgba(239, 68, 68, 0.22); }
  .diff-badge.zero { background: rgba(21, 128, 61, 0.16); color: #86efac; border-color: rgba(34, 197, 94, 0.2); }

  /* ── diff table ── */
  .table-wrap { overflow-x: auto; }
  .diff-table { width: 100%; border-collapse: collapse; font-size: 0.82rem; }
  .diff-table th { background: rgba(20, 29, 45, 0.86); padding: 9px 12px; text-align: left; color: #9fb2ca; font-weight: 600; border-bottom: 1px solid rgba(71, 85, 105, 0.28); white-space: nowrap; }
  .diff-table td { padding: 9px 12px; vertical-align: top; border-bottom: 1px solid rgba(30, 41, 59, 0.75); }
  .diff-table tr:last-child td { border-bottom: none; }
  .diff-table tr:hover td { background: rgba(20, 29, 45, 0.65); }
  .path-cell code { color: #c4b5fd; font-size: 0.8rem; word-break: break-all; }
  .reason-cell { white-space: nowrap; }
  .val-cell { max-width: 320px; word-break: break-word; }
  .expected-col { color: #fecdd3; }
  .actual-col { color: #bbf7d0; }
  .type-cell { font-size: 0.75rem; color: #94a3b8; }
  .dimmed { color: #475569; }
  .no-diff { color: #4ade80; font-size: 0.85rem; padding: 8px 0; }

  /* ── badges ── */
  .badge { display: inline-block; font-size: 0.68rem; padding: 3px 8px; border-radius: 999px; font-weight: 700; border: 1px solid transparent; }
  .badge-mismatch { background: rgba(124, 45, 18, 0.22); color: #fdba74; border-color: rgba(251, 146, 60, 0.24); }
  .badge-type    { background: rgba(76, 29, 149, 0.22); color: #c4b5fd; border-color: rgba(139, 92, 246, 0.22); }
  .badge-missing { background: rgba(127, 29, 29, 0.22); color: #fca5a5; border-color: rgba(239, 68, 68, 0.22); }
  .badge-extra   { background: rgba(30, 58, 95, 0.22); color: #93c5fd; border-color: rgba(59, 130, 246, 0.22); }
  .badge-other   { background: rgba(28, 25, 23, 0.28); color: #d6d3d1; border-color: rgba(120, 113, 108, 0.22); }

  /* ── JSON tree ── */
  .json-tree { display: inline; }
  .json-summary { cursor: pointer; color: #fbbf24; font-size: 0.78rem; display: inline; list-style: none; }
  .json-summary::-webkit-details-marker { display: none; }
  .json-toggle { font-size: 0.65rem; color: #64748b; }
  .json-block { white-space: pre-wrap; background: rgba(20, 29, 45, 0.88); border: 1px solid rgba(71, 85, 105, 0.2); border-radius: 8px; padding: 10px; font-size: 0.75rem; color: #bfdbfe; margin-top: 6px; max-height: 300px; overflow-y: auto; }

  /* ── scalar / null ── */
  .scalar-val { font-family: monospace; }
  .null-val { color: #64748b; font-style: italic; }
  .missing-val { color: #f87171; font-style: italic; }

  /* ── request section ── */
  .req-section { border: 1px solid rgba(71, 85, 105, 0.34); border-radius: 12px; margin-bottom: 12px; overflow: hidden; background: rgba(20, 29, 45, 0.86); }
  .req-summary { cursor: pointer; padding: 12px 16px; background: rgba(20, 29, 45, 0.96); list-style: none; font-size: 0.84rem; display: flex; align-items: center; justify-content: space-between; gap: 12px; }
  .req-summary::-webkit-details-marker { display: none; }
  .req-count { display: inline-flex; align-items: center; justify-content: center; min-width: 28px; height: 28px; padding: 0 8px; border-radius: 999px; background: rgba(15, 23, 42, 0.88); border: 1px solid rgba(71, 85, 105, 0.34); color: #dbe4f0; font-size: 0.75rem; font-weight: 700; }
  .req-table { width: 100%; border-collapse: collapse; font-size: 0.8rem; }
  .req-table th { background: rgba(20, 29, 45, 0.9); padding: 8px 10px; text-align: left; color: #9fb2ca; border-bottom: 1px solid rgba(71, 85, 105, 0.28); }
  .req-table td { padding: 8px 10px; vertical-align: top; border-bottom: 1px solid rgba(30, 41, 59, 0.75); }
  .http-err { color: #f87171; font-weight: 700; }
  .err-msg { color: #fca5a5; max-width: 240px; }

  /* ── separator ── */
  .section-title { font-size: 0.8rem; font-weight: 700; color: #9fb2ca; margin: 4px 0 10px; text-transform: uppercase; letter-spacing: 0.12em; }
  hr.divider { border: none; border-top: 1px solid rgba(51, 65, 85, 0.55); margin: 8px 0 0; }

  @media (max-width: 840px) {
    body { padding: 16px; }
    h1 { font-size: 1.65rem; }
    .header-row { flex-direction: column; align-items: flex-start; }
    .summary-pills { gap: 8px; }
    .val-cell { max-width: 220px; }
    .req-summary { align-items: flex-start; }
  }
</style>
</head>
<body>
<div class="container">

  <div class="report-shell">
    <div class="report-header">
      <div class="header-row">
        <div>
          <div class="eyebrow">ART replay report</div>
          <h1>ART Comparison Report</h1>
        </div>
        <div class="overall-status ${overallOk ? 'is-ok' : 'is-fail'}">${statusLabel}</div>
      </div>
      <div class="meta-grid">
        <div class="meta-card">
          <span class="meta-label">Execution ID</span>
          <strong class="meta-value meta-mono">${execId}</strong>
        </div>
        <div class="meta-card">
          <span class="meta-label">Started</span>
          <strong class="meta-value">${esc(startTime)}</strong>
        </div>
        <div class="meta-card">
          <span class="meta-label">Duration</span>
          <strong class="meta-value">${esc(duration)}</strong>
        </div>
      </div>
    </div>

    <div class="stats-grid">
      <div class="stat-card">
        <span class="stat-label">Orders</span>
        <strong class="stat-value">${summary.totalOrders ?? 0}</strong>
      </div>
      <div class="stat-card">
        <span class="stat-label">Passed</span>
        <strong class="stat-value stat-ok">${summary.completed ?? 0}</strong>
      </div>
      <div class="stat-card">
        <span class="stat-label">Failed</span>
        <strong class="stat-value stat-fail">${summary.failed ?? 0}</strong>
      </div>
      <div class="stat-card">
        <span class="stat-label">Skipped</span>
        <strong class="stat-value">${summary.skipped ?? 0}</strong>
      </div>
      <div class="stat-card">
        <span class="stat-label">Comparisons</span>
        <strong class="stat-value">${summary.totalPayloadComparisons ?? 0}</strong>
      </div>
      <div class="stat-card">
        <span class="stat-label">Mismatches</span>
        <strong class="stat-value ${(summary.totalPayloadMismatches ?? 0) > 0 ? 'stat-warn' : 'stat-ok'}">${summary.totalPayloadMismatches ?? 0}</strong>
      </div>
      ${(summary.stuck ?? 0) > 0 ? `<div class="stat-card">
        <span class="stat-label">Stuck</span>
        <strong class="stat-value stat-warn">${summary.stuck}</strong>
      </div>` : ''}
      ${(summary.timeout ?? 0) > 0 ? `<div class="stat-card">
        <span class="stat-label">Timeout</span>
        <strong class="stat-value stat-warn">${summary.timeout}</strong>
      </div>` : ''}
      ${(summary.totalBufferFailures ?? 0) > 0 ? `<div class="stat-card">
        <span class="stat-label">Buffer failures</span>
        <strong class="stat-value stat-fail">${summary.totalBufferFailures}</strong>
      </div>` : ''}
    </div>

  <!-- API Payload Comparisons per order -->
  ${orderSections || '<p class="no-diff">No payload comparison data available.</p>'}

  <!-- Uncovered orders -->
  ${uncoveredHtml}

  <!-- Buffer / API failure details -->
  ${requestSections ? `<hr class="divider"><p class="section-title">API / Buffer Failure Details</p>${requestSections}` : ''}

  </div>

</div>
</body>
</html>`;
}

export default generateHtmlReport;
