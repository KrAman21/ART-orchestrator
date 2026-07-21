import PDFDocument from 'pdfkit';
import { createWriteStream, mkdirSync } from 'fs';
import { resolve, dirname, basename } from 'path';

/**
 * Generates a PDF report from the ART report JSON.
 * Written next to the JSON file with a .pdf extension.
 *
 * @param {object} report - The ART report object.
 * @param {string} jsonReportPath - Absolute path to the JSON report file.
 * @returns {Promise<string>} Absolute path to the generated PDF file.
 */
export function generatePdfReport(report, jsonReportPath) {
  const pdfPath = resolve(
    dirname(jsonReportPath),
    basename(jsonReportPath, '.json') + '.pdf'
  );

  mkdirSync(dirname(pdfPath), { recursive: true });

  return new Promise((resolve_p, reject) => {
    const doc = new PDFDocument({ margin: 40, size: 'A4' });
    const stream = createWriteStream(pdfPath);
    doc.pipe(stream);

    stream.on('finish', () => resolve_p(pdfPath));
    stream.on('error', reject);

    // ── palette ──────────────────────────────────────────────────────────────
    const C = {
      bg:       '#0f172a',
      card:     '#1e293b',
      heading:  '#e2e8f0',
      sub:      '#94a3b8',
      green:    '#22c55e',
      red:      '#ef4444',
      yellow:   '#f59e0b',
      blue:     '#60a5fa',
      purple:   '#c4b5fd',
      pink:     '#fda4af',
      teal:     '#a5f3fc',
      muted:    '#475569',
      white:    '#ffffff',
    };

    const PAGE_W = doc.page.width - 80; // usable width

    // ── helpers ───────────────────────────────────────────────────────────────
    function fillPage() {
      doc.rect(0, 0, doc.page.width, doc.page.height).fill(C.bg);
    }

    function hline(y, color = C.muted) {
      doc.moveTo(40, y).lineTo(doc.page.width - 40, y).strokeColor(color).lineWidth(0.5).stroke();
    }

    function pill(x, y, text, bg, fg) {
      const PAD = 6;
      doc.fontSize(7).font('Helvetica');
      const tw = doc.widthOfString(text);
      doc.roundedRect(x, y, tw + PAD * 2, 13, 4).fill(bg);
      doc.fillColor(fg).text(text, x + PAD, y + 2.5, { lineBreak: false });
      return tw + PAD * 2 + 6;
    }

    function safeTrunc(val, max = 80) {
      if (val === null || val === undefined) return 'null';
      if (val === '<missing>') return '<missing>';
      const s = typeof val === 'object' ? JSON.stringify(val) : String(val);
      return s.length > max ? s.slice(0, max) + '…' : s;
    }

    // ── COVER PAGE ────────────────────────────────────────────────────────────
    fillPage();

    const summary = report.summary || {};
    const overallOk = report.overallStatus === 'SUCCESS';

    // header stripe
    doc.rect(0, 0, doc.page.width, 8).fill(overallOk ? C.green : C.red);

    doc.fontSize(22).font('Helvetica-Bold').fillColor(C.heading)
      .text('ART Comparison Report', 40, 30, { width: PAGE_W });

    const statusLabel = overallOk ? '● SUCCESS' : '● PARTIAL FAILURE';
    doc.fontSize(13).font('Helvetica-Bold')
      .fillColor(overallOk ? C.green : C.red)
      .text(statusLabel, 40, 60);

    doc.fontSize(8).font('Helvetica').fillColor(C.sub);
    const startTime = report.executionStartTime
      ? new Date(report.executionStartTime).toLocaleString()
      : '—';
    const dur = report.totalDuration != null
      ? `${(report.totalDuration / 1000).toFixed(1)}s`
      : '—';
    doc.text(`Execution ID: ${report.executionId || '—'}   •   Started: ${startTime}   •   Duration: ${dur}`, 40, 78);

    hline(94);

    // summary pills row
    let px = 40;
    let py = 100;
    px += pill(px, py, `${summary.totalOrders ?? 0} orders`, '#1e3a5f', C.blue);
    px += pill(px, py, `${summary.completed ?? 0} passed`, '#14532d', C.green);
    px += pill(px, py, `${summary.failed ?? 0} failed`, '#450a0a', C.red);
    if ((summary.stuck ?? 0) > 0)   px += pill(px, py, `${summary.stuck} stuck`, '#451a03', C.yellow);
    if ((summary.timeout ?? 0) > 0) px += pill(px, py, `${summary.timeout} timeout`, '#451a03', C.yellow);
    px += pill(px, py, `${summary.totalPayloadComparisons ?? 0} comparisons`, '#1e293b', C.sub);
    px += pill(px, py, `${summary.totalPayloadMismatches ?? 0} mismatches`, (summary.totalPayloadMismatches ?? 0) > 0 ? '#450a0a' : '#14532d', (summary.totalPayloadMismatches ?? 0) > 0 ? C.red : C.green);
    if ((summary.totalBufferFailures ?? 0) > 0)
      pill(px, py, `${summary.totalBufferFailures} buffer failures`, '#451a03', C.yellow);
    if ((summary.totalFlowFailures ?? 0) > 0)
      pill(px, py + 20, `${summary.totalFlowFailures} flow failures`, '#450a0a', C.red);
    if ((summary.totalArtFailures ?? 0) > 0)
      pill(px + 150, py + 20, `${summary.totalArtFailures} art failures`, '#1e293b', C.yellow);

    // order outcomes table
    let y = 122;
    doc.fontSize(10).font('Helvetica-Bold').fillColor(C.heading).text('Order Outcomes', 40, y);
    y += 16;
    hline(y, C.card);
    y += 4;

    for (const order of report.orderOutcomes || []) {
      if (y > doc.page.height - 60) { doc.addPage(); fillPage(); y = 40; }
      const ok = order.status === 'COMPLETED';
      const icon = ok ? '✓' : '✗';
      const color = ok ? C.green : C.red;
      doc.fontSize(8).font('Helvetica-Bold').fillColor(color).text(icon, 40, y, { lineBreak: false, width: 12 });
      doc.fillColor(C.heading).text(order.orderId, 54, y, { lineBreak: false, width: 180 });
      doc.fillColor(C.sub).text(order.status, 240, y, { lineBreak: false, width: 70 });
      doc.fillColor(C.sub).text(order.logTag || '—', 316, y, { lineBreak: false, width: 120 });
      doc.fillColor(C.sub).text(order.processingTimeMs != null ? `${(order.processingTimeMs / 1000).toFixed(1)}s` : '—', 442, y, { lineBreak: false, width: 40 });
      const orderFetchLabel = order.fetchDiagnostics?.orderFetch?.success === true ? 'order:OK' : order.fetchDiagnostics?.orderFetch?.success === false ? 'order:FAIL' : 'order:?';
      const laFetchLabel = order.fetchDiagnostics?.summary?.allLoanApplicationFetchesSuccessful === true ? 'la:OK' : order.fetchDiagnostics?.summary?.allLoanApplicationFetchesSuccessful === false ? 'la:FAIL' : 'la:?';
      doc.fillColor(C.sub).text(`${orderFetchLabel} ${laFetchLabel}`, 486, y, { lineBreak: false, width: 70 });
      if (!ok && order.failureReason) {
        y += 10;
        doc.fontSize(7).font('Helvetica').fillColor(C.red)
          .text(`  ↳ ${safeTrunc(order.failureReason, 100)}`, 54, y, { width: PAGE_W - 14 });
      }
      y += 14;
      hline(y, C.muted);
      y += 4;
    }

    // ── PAYLOAD COMPARISONS ────────────────────────────────────────────────────
    for (const orderComp of report.payloadComparisons || []) {
      doc.addPage();
      fillPage();
      doc.rect(0, 0, doc.page.width, 8).fill(C.blue);

      y = 20;
      doc.fontSize(11).font('Helvetica-Bold').fillColor(C.blue)
        .text(`Order: ${orderComp.orderId}`, 40, y);
      const orderStatus = orderComp.status;
      const sc = orderStatus === 'COMPLETED' ? C.green : C.red;
      doc.fontSize(8).font('Helvetica').fillColor(sc).text(orderStatus, 40, y + 14);
      y += 30;
      hline(y, C.card);
      y += 6;

      // group by logTag
      const tagMap = new Map();
      for (const comp of orderComp.comparisons || []) {
        const tag = comp.logTag || 'unknown';
        if (!tagMap.has(tag)) tagMap.set(tag, []);
        tagMap.get(tag).push(comp);
      }

      for (const [tag, comps] of tagMap) {
        const totalDiffs = comps.reduce((s, c) => s + (c.differenceCount || 0), 0);

        if (y > doc.page.height - 60) { doc.addPage(); fillPage(); y = 30; }

        // tag header
        const tagColor = totalDiffs > 0 ? C.red : C.green;
        const tagIcon  = totalDiffs > 0 ? '✗' : '✓';
        doc.rect(40, y, PAGE_W, 16).fill(C.card);
        doc.fontSize(9).font('Helvetica-Bold').fillColor(tagColor)
          .text(`${tagIcon}  ${tag}`, 46, y + 3, { lineBreak: false, width: PAGE_W - 120 });
        doc.fontSize(7).font('Helvetica').fillColor(totalDiffs > 0 ? C.red : C.sub)
          .text(`${totalDiffs} diff${totalDiffs !== 1 ? 's' : ''}`, doc.page.width - 100, y + 4, { lineBreak: false });
        y += 20;

        if (totalDiffs === 0) { y += 4; continue; }

        // column headers
        if (y > doc.page.height - 40) { doc.addPage(); fillPage(); y = 30; }
        doc.fontSize(6.5).font('Helvetica-Bold').fillColor(C.sub);
        doc.text('PATH',     46,  y, { lineBreak: false, width: 150 });
        doc.text('STATUS',   200, y, { lineBreak: false, width: 80 });
        doc.text('EXPECTED', 284, y, { lineBreak: false, width: 130 });
        doc.text('ACTUAL',   418, y, { lineBreak: false, width: 130 });
        y += 10;
        hline(y, C.muted);
        y += 3;

        for (const comp of comps) {
          for (const diff of comp.differences || []) {
            if (y > doc.page.height - 30) { doc.addPage(); fillPage(); y = 30; }

            const reasonColor = {
              'value mismatch':              C.yellow,
              'type mismatch':               C.purple,
              'key missing in actual':       C.red,
              'extra key in actual':         C.blue,
              'element missing in actual':   C.red,
              'extra element in actual':     C.blue,
              'expected missing, actual present': C.blue,
              'expected present, actual missing': C.red,
            }[diff.reason] || C.sub;

            doc.fontSize(7).font('Helvetica-Bold').fillColor(C.teal)
              .text(safeTrunc(diff.path || 'root', 30), 46, y, { lineBreak: false, width: 150 });
            doc.font('Helvetica').fillColor(reasonColor)
              .text(safeTrunc(diff.reason, 24), 200, y, { lineBreak: false, width: 80 });
            doc.fillColor(C.pink)
              .text(safeTrunc(diff.expected, 28), 284, y, { lineBreak: false, width: 130 });
            doc.fillColor(C.green)
              .text(safeTrunc(diff.actual, 28), 418, y, { lineBreak: false, width: 130 });
            y += 12;
          }
        }
        y += 6;
        hline(y, C.muted);
        y += 4;
      }
    }

    // ── BUFFER FAILURES ────────────────────────────────────────────────────────
    if ((report.requestDetails || []).some(r => r.requests?.length > 0)) {
      doc.addPage();
      fillPage();
      doc.rect(0, 0, doc.page.width, 8).fill(C.yellow);
      y = 20;
      doc.fontSize(11).font('Helvetica-Bold').fillColor(C.yellow)
        .text('API / Buffer Failures', 40, y);
      y += 20;

      for (const detail of report.requestDetails || []) {
        for (const req of detail.requests || []) {
          if (y > doc.page.height - 80) { doc.addPage(); fillPage(); y = 30; }

          doc.rect(40, y, PAGE_W, 14).fill(C.card);
          doc.fontSize(8).font('Helvetica-Bold').fillColor(C.red)
            .text(req.logTag || '—', 46, y + 2, { lineBreak: false, width: 200 });
          doc.fillColor(C.sub).font('Helvetica')
            .text(`HTTP ${req.httpStatus ?? '—'}`, doc.page.width - 100, y + 2, { lineBreak: false });
          y += 18;

          doc.fontSize(7).font('Helvetica').fillColor(C.sub)
            .text(`Endpoint: `, 46, y, { lineBreak: false });
          doc.fillColor(C.blue).text(req.endpoint || '—', 90, y, { lineBreak: false, width: PAGE_W - 50 });
          y += 10;

          if (req.errorMessage) {
            doc.fillColor(C.red).text(`Error: ${safeTrunc(req.errorMessage, 100)}`, 46, y, { width: PAGE_W - 6 });
            y += 10;
          }

          if (req.requestPayload) {
            const payload = typeof req.requestPayload === 'string'
              ? req.requestPayload
              : JSON.stringify(req.requestPayload, null, 2);
            doc.fillColor(C.sub).text('Request:', 46, y);
            y += 10;
            doc.fontSize(6.5).fillColor(C.teal)
              .text(safeTrunc(payload, 300), 54, y, { width: PAGE_W - 14, lineBreak: true });
            y += doc.heightOfString(safeTrunc(payload, 300), { width: PAGE_W - 14, fontSize: 6.5 }) + 4;
          }
          hline(y, C.muted);
          y += 8;
        }
      }
    }

    doc.end();
  });
}

export default generatePdfReport;
