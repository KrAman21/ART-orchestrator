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

function formatDurationMs(ms) {
  if (ms == null) return '—';
  return `${(ms / 1000).toFixed(1)}s`;
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
  const fetchSummary = orderOutcome?.fetchDiagnostics?.summary || null;
  const orderFetchSuccess = orderOutcome?.fetchDiagnostics?.orderFetch?.success;
  const laFetchSuccess = fetchSummary?.allLoanApplicationFetchesSuccessful;
  const failedLaids = fetchSummary?.failedLoanApplicationIds || [];
  const fetchPills = orderOutcome
    ? [
      `<span class="pill ${orderFetchSuccess === true ? 'pill-ok' : orderFetchSuccess === false ? 'pill-fail' : 'pill-total'}">order fetch: ${esc(orderFetchSuccess === true ? 'SUCCESS' : orderFetchSuccess === false ? 'FAILED' : 'UNKNOWN')}</span>`,
      `<span class="pill ${laFetchSuccess === true ? 'pill-ok' : laFetchSuccess === false ? 'pill-fail' : 'pill-total'}">la fetch: ${esc(laFetchSuccess === true ? 'SUCCESS' : laFetchSuccess === false ? 'FAILED' : 'UNKNOWN')}</span>`
    ].join('')
    : '';
  const fetchFailureNote = failedLaids.length > 0
    ? `<div class="failure-banner"><span class="failure-label">Failed LAIDs</span><code>${esc(failedLaids.join(', '))}</code></div>`
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
    ${fetchFailureNote}
    <div class="summary-pills">
      <span class="pill pill-total">${formatDurationMs(orderOutcome?.processingTimeMs)}</span>
      <span class="pill pill-diff">${esc(orderOutcome?.failureCategory || 'NO_FAILURE')}</span>
      ${fetchPills}
      <span class="pill pill-total">${totalTags} API tags</span>
      <span class="pill pill-ok">${matchedTags} matched</span>
      <span class="pill pill-fail">${mismatchedTags} mismatched</span>
      <span class="pill pill-diff">${totalDiffs} total diffs</span>
    </div>
    <div class="tag-list">${tagSections || '<p class="no-diff">No payload comparisons recorded.</p>'}</div>
  </section>`;
}

function buildRequestSection(reqDetail, title) {
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
    <summary class="req-summary">${esc(title)} for <code>${esc(reqDetail.orderId)}</code> <span class="req-count">${reqDetail.requests.length}</span></summary>
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
    .map(detail => buildRequestSection(detail, 'Flow failures'))
    .join('\n');

  const bufferFailureSections = (report.bufferFailureDetails || [])
    .map(detail => buildRequestSection(detail, 'Expected event / buffer failures'))
    .join('\n');

  const artFailureSections = (report.artFailureDetails || [])
    .map(detail => buildRequestSection(detail, 'ART failures'))
    .join('\n');

  // Orders with no payload comparisons (e.g. failed very early)
  const comparedIds = new Set((report.payloadComparisons || []).map(o => o.orderId));
  const uncoveredOutcomes = (report.orderOutcomes || []).filter(o => !comparedIds.has(o.orderId));
  const uncoveredHtml = uncoveredOutcomes.length > 0
    ? `<section class="order-section uncovered">
        <h2 class="order-title">Orders with no comparison data</h2>
        <ul>${uncoveredOutcomes.map(o =>
          `<li><code>${esc(o.orderId)}</code> — <span class="status-fail">${esc(o.status)}</span> · ${esc(o.failureCategory || 'NO_FAILURE')} · order fetch: ${esc(o.fetchDiagnostics?.orderFetch?.success === true ? 'SUCCESS' : o.fetchDiagnostics?.orderFetch?.success === false ? 'FAILED' : 'UNKNOWN')} · la fetch: ${esc(o.fetchDiagnostics?.summary?.allLoanApplicationFetchesSuccessful === true ? 'SUCCESS' : o.fetchDiagnostics?.summary?.allLoanApplicationFetchesSuccessful === false ? 'FAILED' : 'UNKNOWN')} · ${esc(formatDurationMs(o.processingTimeMs))}: ${esc(o.failureReason || o.stopReason || '')}</li>`
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
  @import url('https://fonts.googleapis.com/css2?family=Manrope:wght@500;600;700;800&family=JetBrains+Mono:wght@500;700&display=swap');

  :root {
    --bg: #0f172a;
    --bg-2: #172554;
    --panel: rgba(255, 255, 255, 0.9);
    --panel-strong: rgba(255, 255, 255, 0.96);
    --panel-tint: rgba(236, 242, 255, 0.92);
    --line: rgba(148, 163, 184, 0.22);
    --line-strong: rgba(71, 85, 105, 0.2);
    --text: #0f172a;
    --text-soft: #475569;
    --text-dim: #64748b;
    --blue: #2563eb;
    --blue-soft: rgba(37, 99, 235, 0.12);
    --green: #15803d;
    --green-soft: rgba(22, 163, 74, 0.12);
    --red: #b91c1c;
    --red-soft: rgba(220, 38, 38, 0.12);
    --amber: #b45309;
    --amber-soft: rgba(245, 158, 11, 0.14);
    --shadow-lg: 0 28px 80px rgba(15, 23, 42, 0.22);
    --shadow-md: 0 18px 40px rgba(15, 23, 42, 0.12);
    --radius-xl: 28px;
    --radius-lg: 22px;
    --radius-md: 16px;
    --radius-sm: 12px;
  }

  *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }
  html { scroll-behavior: smooth; }
  body {
    font-family: "Manrope", "Segoe UI", Arial, sans-serif;
    background:
      radial-gradient(circle at top left, rgba(96, 165, 250, 0.22), transparent 30%),
      radial-gradient(circle at top right, rgba(34, 197, 94, 0.16), transparent 28%),
      linear-gradient(180deg, #eaf1ff 0%, #f8fbff 42%, #eef4ff 100%);
    color: var(--text);
    line-height: 1.6;
    padding: 32px 20px 56px;
  }
  a { color: var(--blue); }
  code, pre, .meta-mono, .order-id, .tag-name, .entry-label, .failure-banner code, .path-cell code, .scalar-val {
    font-family: "JetBrains Mono", "SFMono-Regular", Consolas, monospace;
  }

  .container { max-width: 1440px; margin: 0 auto; }
  .report-shell { display: flex; flex-direction: column; gap: 22px; }
  h1 {
    font-size: clamp(2.35rem, 3vw, 3.3rem);
    line-height: 1.05;
    letter-spacing: -0.05em;
    color: #081121;
    max-width: 720px;
  }
  h2.order-title {
    font-size: 1.2rem;
    display: flex;
    align-items: center;
    gap: 10px;
    margin-bottom: 6px;
    flex-wrap: wrap;
  }
  .eyebrow {
    font-size: 0.78rem;
    text-transform: uppercase;
    letter-spacing: 0.18em;
    color: var(--blue);
    margin-bottom: 12px;
    font-weight: 800;
  }

  .report-header {
    position: relative;
    overflow: hidden;
    background:
      linear-gradient(135deg, rgba(255, 255, 255, 0.96), rgba(241, 247, 255, 0.92)),
      linear-gradient(135deg, #ffffff, #eff6ff);
    border-radius: var(--radius-xl);
    padding: 30px;
    border: 1px solid rgba(191, 219, 254, 0.8);
    box-shadow: var(--shadow-lg);
  }
  .report-header::before {
    content: "";
    position: absolute;
    inset: auto -80px -120px auto;
    width: 320px;
    height: 320px;
    background: radial-gradient(circle, rgba(37, 99, 235, 0.14), transparent 68%);
    pointer-events: none;
  }
  .header-row {
    position: relative;
    display: flex;
    align-items: flex-start;
    justify-content: space-between;
    gap: 18px;
    margin-bottom: 24px;
  }
  .header-copy {
    display: flex;
    flex-direction: column;
    gap: 14px;
  }
  .hero-note {
    max-width: 760px;
    font-size: 0.98rem;
    color: var(--text-soft);
  }
  .overall-status {
    font-size: 0.86rem;
    font-weight: 800;
    letter-spacing: 0.08em;
    text-transform: uppercase;
    padding: 11px 16px;
    border-radius: 999px;
    border: 1px solid currentColor;
    backdrop-filter: blur(12px);
    box-shadow: inset 0 0 0 1px rgba(255, 255, 255, 0.25);
  }
  .overall-status.is-ok { color: var(--green); background: rgba(220, 252, 231, 0.85); }
  .overall-status.is-fail { color: var(--red); background: rgba(254, 226, 226, 0.9); }

  .meta-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(220px, 1fr)); gap: 14px; }
  .meta-card {
    background: var(--panel);
    border: 1px solid rgba(203, 213, 225, 0.9);
    border-radius: var(--radius-md);
    padding: 16px 18px;
    box-shadow: inset 0 1px 0 rgba(255, 255, 255, 0.65);
  }
  .meta-label {
    display: block;
    font-size: 0.72rem;
    text-transform: uppercase;
    letter-spacing: 0.12em;
    color: var(--text-dim);
    margin-bottom: 8px;
    font-weight: 800;
  }
  .meta-value { color: #081121; font-size: 1rem; }
  .meta-mono { font-size: 0.84rem; word-break: break-all; }

  .stats-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(160px, 1fr)); gap: 14px; }
  .stat-card {
    background: var(--panel-strong);
    border: 1px solid rgba(203, 213, 225, 0.95);
    border-radius: var(--radius-lg);
    padding: 18px;
    min-height: 104px;
    display: flex;
    flex-direction: column;
    justify-content: space-between;
    box-shadow: var(--shadow-md);
  }
  .stat-label {
    font-size: 0.76rem;
    text-transform: uppercase;
    letter-spacing: 0.1em;
    color: var(--text-dim);
    font-weight: 800;
  }
  .stat-value {
    font-size: clamp(1.8rem, 2vw, 2.35rem);
    font-weight: 800;
    color: #081121;
    letter-spacing: -0.05em;
  }
  .stat-ok { color: var(--green); }
  .stat-fail { color: var(--red); }
  .stat-warn { color: var(--amber); }

  .order-section {
    background: var(--panel-strong);
    border-radius: var(--radius-lg);
    padding: 24px;
    border: 1px solid rgba(203, 213, 225, 0.95);
    box-shadow: var(--shadow-md);
  }
  .order-section.uncovered {
    background: rgba(255, 255, 255, 0.88);
    border-style: dashed;
  }
  .order-head { margin-bottom: 18px; }
  .order-subtitle { font-size: 0.92rem; color: var(--text-soft); }
  .order-id { color: #1d4ed8; font-weight: 700; }
  .order-status {
    font-size: 0.72rem;
    padding: 5px 11px;
    border-radius: 999px;
    font-weight: 800;
    letter-spacing: 0.08em;
    text-transform: uppercase;
  }
  .status-ok { background: var(--green-soft); color: var(--green); border: 1px solid rgba(22, 163, 74, 0.22); }
  .status-fail { background: var(--red-soft); color: var(--red); border: 1px solid rgba(220, 38, 38, 0.18); }
  .failure-banner {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: 10px;
    background: linear-gradient(135deg, rgba(255, 247, 237, 0.96), rgba(255, 251, 235, 0.96));
    border: 1px solid rgba(251, 191, 36, 0.45);
    border-radius: var(--radius-sm);
    padding: 12px 14px;
    margin-bottom: 16px;
    font-size: 0.88rem;
    color: var(--amber);
  }
  .failure-label {
    font-size: 0.72rem;
    text-transform: uppercase;
    letter-spacing: 0.1em;
    color: #d97706;
    font-weight: 800;
  }
  .failure-reason { color: var(--text); }
  .failure-banner code { color: #92400e; font-weight: 700; }

  .summary-pills { display: flex; flex-wrap: wrap; gap: 10px; margin-bottom: 18px; }
  .pill {
    font-size: 0.78rem;
    padding: 7px 12px;
    border-radius: 999px;
    font-weight: 800;
    border: 1px solid transparent;
    background: #f8fbff;
  }
  .pill-total { color: #1d4ed8; border-color: rgba(37, 99, 235, 0.18); background: rgba(239, 246, 255, 0.9); }
  .pill-ok { color: var(--green); border-color: rgba(22, 163, 74, 0.18); background: rgba(240, 253, 244, 0.95); }
  .pill-fail { color: var(--red); border-color: rgba(220, 38, 38, 0.16); background: rgba(254, 242, 242, 0.95); }
  .pill-diff { color: var(--amber); border-color: rgba(245, 158, 11, 0.18); background: rgba(255, 251, 235, 0.96); }

  .tag-list { display: flex; flex-direction: column; gap: 12px; }
  .tag-section {
    border-radius: var(--radius-md);
    border: 1px solid var(--line);
    overflow: hidden;
    background: var(--panel-tint);
  }
  .tag-section.tag-fail { border-color: rgba(239, 68, 68, 0.22); }
  .tag-section.tag-pass { border-color: rgba(34, 197, 94, 0.22); }
  .tag-summary {
    cursor: pointer;
    padding: 15px 18px;
    display: flex;
    align-items: center;
    gap: 12px;
    background: rgba(255, 255, 255, 0.88);
    user-select: none;
    list-style: none;
  }
  .tag-summary::-webkit-details-marker { display: none; }
  .tag-section[open] .tag-summary { border-bottom: 1px solid rgba(203, 213, 225, 0.9); }
  .tag-icon { font-size: 0.95rem; }
  .tag-name {
    font-size: 0.92rem;
    font-weight: 700;
    flex: 1;
    color: #0f172a;
  }
  .tag-meta { font-size: 0.78rem; color: var(--text-soft); }
  .tag-body { padding: 16px 18px; background: rgba(248, 251, 255, 0.9); }

  .comp-entry {
    border: 1px solid rgba(203, 213, 225, 0.95);
    border-radius: var(--radius-sm);
    margin-bottom: 12px;
    overflow: hidden;
    background: rgba(255, 255, 255, 0.9);
  }
  .comp-entry:last-child { margin-bottom: 0; }
  .comp-entry-summary {
    cursor: pointer;
    padding: 10px 14px;
    background: rgba(241, 245, 249, 0.92);
    font-size: 0.82rem;
    display: flex;
    align-items: center;
    gap: 8px;
    list-style: none;
  }
  .comp-entry-summary::-webkit-details-marker { display: none; }
  .entry-label { color: #1d4ed8; font-weight: 700; }
  .ts { color: var(--text-dim); font-size: 0.75rem; }
  .diff-badge {
    font-size: 0.7rem;
    padding: 4px 8px;
    border-radius: 999px;
    background: rgba(254, 226, 226, 0.9);
    color: var(--red);
    font-weight: 800;
    border: 1px solid rgba(248, 113, 113, 0.22);
  }
  .diff-badge.zero {
    background: rgba(220, 252, 231, 0.9);
    color: var(--green);
    border-color: rgba(34, 197, 94, 0.18);
  }

  .table-wrap {
    overflow-x: auto;
    border: 1px solid rgba(226, 232, 240, 0.95);
    border-radius: 14px;
    background: rgba(255, 255, 255, 0.88);
  }
  .diff-table, .req-table { width: 100%; border-collapse: collapse; font-size: 0.84rem; }
  .diff-table th, .req-table th {
    position: sticky;
    top: 0;
    background: #eff6ff;
    padding: 11px 12px;
    text-align: left;
    color: #334155;
    font-weight: 800;
    border-bottom: 1px solid rgba(203, 213, 225, 0.95);
    white-space: nowrap;
  }
  .diff-table td, .req-table td {
    padding: 11px 12px;
    vertical-align: top;
    border-bottom: 1px solid rgba(226, 232, 240, 0.95);
  }
  .diff-table tr:last-child td, .req-table tr:last-child td { border-bottom: none; }
  .diff-table tbody tr:nth-child(even) td,
  .req-table tbody tr:nth-child(even) td { background: rgba(248, 250, 252, 0.9); }
  .diff-table tbody tr:hover td,
  .req-table tbody tr:hover td { background: rgba(239, 246, 255, 0.9); }
  .path-cell code { color: #7c3aed; font-size: 0.78rem; word-break: break-all; }
  .reason-cell { white-space: nowrap; }
  .val-cell { max-width: 360px; word-break: break-word; }
  .expected-col { color: #9f1239; }
  .actual-col { color: #166534; }
  .type-cell { font-size: 0.76rem; color: var(--text-dim); }
  .dimmed { color: #94a3b8; }
  .no-diff { color: var(--green); font-size: 0.92rem; padding: 8px 0; font-weight: 700; }

  .badge {
    display: inline-block;
    font-size: 0.68rem;
    padding: 4px 8px;
    border-radius: 999px;
    font-weight: 800;
    border: 1px solid transparent;
  }
  .badge-mismatch { background: rgba(255, 237, 213, 0.95); color: #c2410c; border-color: rgba(251, 146, 60, 0.22); }
  .badge-type    { background: rgba(237, 233, 254, 0.95); color: #6d28d9; border-color: rgba(167, 139, 250, 0.22); }
  .badge-missing { background: rgba(254, 226, 226, 0.95); color: var(--red); border-color: rgba(248, 113, 113, 0.2); }
  .badge-extra   { background: rgba(219, 234, 254, 0.95); color: var(--blue); border-color: rgba(96, 165, 250, 0.22); }
  .badge-other   { background: rgba(241, 245, 249, 0.96); color: #475569; border-color: rgba(148, 163, 184, 0.22); }

  .json-tree { display: inline; }
  .json-summary {
    cursor: pointer;
    color: #b45309;
    font-size: 0.78rem;
    display: inline;
    list-style: none;
    font-weight: 700;
  }
  .json-summary::-webkit-details-marker { display: none; }
  .json-toggle { font-size: 0.66rem; color: var(--text-dim); }
  .json-block {
    white-space: pre-wrap;
    background: #0f172a;
    border: 1px solid rgba(30, 41, 59, 0.9);
    border-radius: 10px;
    padding: 12px;
    font-size: 0.76rem;
    color: #dbeafe;
    margin-top: 8px;
    max-height: 320px;
    overflow-y: auto;
  }

  .null-val { color: var(--text-dim); font-style: italic; }
  .missing-val { color: var(--red); font-style: italic; }

  .req-section {
    border: 1px solid rgba(203, 213, 225, 0.95);
    border-radius: var(--radius-md);
    margin-bottom: 14px;
    overflow: hidden;
    background: var(--panel-strong);
    box-shadow: var(--shadow-md);
  }
  .req-summary {
    cursor: pointer;
    padding: 14px 18px;
    background: rgba(248, 250, 252, 0.96);
    list-style: none;
    font-size: 0.88rem;
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 12px;
    font-weight: 700;
  }
  .req-summary::-webkit-details-marker { display: none; }
  .req-count {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    min-width: 30px;
    height: 30px;
    padding: 0 8px;
    border-radius: 999px;
    background: rgba(219, 234, 254, 0.95);
    border: 1px solid rgba(96, 165, 250, 0.22);
    color: #1d4ed8;
    font-size: 0.75rem;
    font-weight: 800;
  }
  .http-err { color: var(--red); font-weight: 800; }
  .err-msg { color: #be123c; max-width: 240px; }

  .section-title {
    font-size: 0.8rem;
    font-weight: 800;
    color: var(--text-dim);
    margin: 6px 0 12px;
    text-transform: uppercase;
    letter-spacing: 0.14em;
  }
  hr.divider {
    border: none;
    border-top: 1px solid rgba(203, 213, 225, 0.95);
    margin: 8px 0 0;
  }

  @media (max-width: 840px) {
    body { padding: 18px 14px 40px; }
    .report-header, .order-section { padding: 18px; }
    .header-row { flex-direction: column; align-items: flex-start; }
    .hero-note { font-size: 0.92rem; }
    .summary-pills { gap: 8px; }
    .val-cell { max-width: 220px; }
    .req-summary, .tag-summary, .comp-entry-summary { align-items: flex-start; }
    h1 { font-size: 2rem; }
  }
</style>
</head>
<body>
<div class="container">

  <div class="report-shell">
    <div class="report-header">
      <div class="header-row">
        <div class="header-copy">
          <div class="eyebrow">ART replay report</div>
          <h1>ART Comparison Report</h1>
          <p class="hero-note">Readable comparison output for replay runs, with clear status cards, grouped API diffs, and failure context that is easier to scan during debugging.</p>
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
      ${(summary.totalFlowFailures ?? 0) > 0 ? `<div class="stat-card">
        <span class="stat-label">Flow failures</span>
        <strong class="stat-value stat-fail">${summary.totalFlowFailures}</strong>
      </div>` : ''}
      ${(summary.totalArtFailures ?? 0) > 0 ? `<div class="stat-card">
        <span class="stat-label">ART failures</span>
        <strong class="stat-value stat-warn">${summary.totalArtFailures}</strong>
      </div>` : ''}
    </div>

  <!-- API Payload Comparisons per order -->
  ${orderSections || '<p class="no-diff">No payload comparison data available.</p>'}

  <!-- Uncovered orders -->
  ${uncoveredHtml}

  <!-- Flow failure details -->
  ${requestSections ? `<hr class="divider"><p class="section-title">Flow Failure Details</p>${requestSections}` : ''}

  <!-- Expected event / buffer failure details -->
  ${bufferFailureSections ? `<hr class="divider"><p class="section-title">Expected Event Failure Details</p>${bufferFailureSections}` : ''}

  <!-- ART failure details -->
  ${artFailureSections ? `<hr class="divider"><p class="section-title">ART Failure Details</p>${artFailureSections}` : ''}

  </div>

</div>
</body>
</html>`;
}

export default generateHtmlReport;
