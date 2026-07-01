import './bootstrap-env.js';

import { mkdir, readFile, writeFile } from 'fs/promises';
import { dirname, resolve } from 'path';
import { generateHtmlReport } from './services/art-html-report-generator.js';
import { generatePdfReport } from './services/art-pdf-report-generator.js';

function parseReportPathArgs() {
  const [, , outputPathArg, ...inputPathArgs] = process.argv;
  const outputPath = outputPathArg || process.env.MERGED_REPORT_PATH || 'logs/art-report.json';
  const inputPaths = inputPathArgs.length > 0
    ? inputPathArgs
    : (process.env.ART_WORKER_REPORTS || '').split(',').map(item => item.trim()).filter(Boolean);

  if (inputPaths.length === 0) {
    throw new Error('No worker reports provided');
  }

  return { outputPath, inputPaths };
}

function minTimestamp(values) {
  const timestamps = values.filter(Boolean).map(value => new Date(value).getTime()).filter(Number.isFinite);
  return timestamps.length > 0 ? new Date(Math.min(...timestamps)).toISOString() : null;
}

function maxTimestamp(values) {
  const timestamps = values.filter(Boolean).map(value => new Date(value).getTime()).filter(Number.isFinite);
  return timestamps.length > 0 ? new Date(Math.max(...timestamps)).toISOString() : null;
}

function sumSummary(reports, key) {
  return reports.reduce((total, report) => total + (report.summary?.[key] || 0), 0);
}

function sumProfilingSummary(reports, key) {
  return reports.reduce((total, report) => total + (report.summary?.profiling?.[key] || 0), 0);
}

async function readReports(inputPaths) {
  const reports = [];

  for (const inputPath of inputPaths) {
    const absolutePath = resolve(process.cwd(), inputPath);
    const report = JSON.parse(await readFile(absolutePath, 'utf-8'));
    reports.push({
      ...report,
      workerReportPath: absolutePath
    });
  }

  return reports;
}

function mergeReports(reports) {
  const executionStartTime = minTimestamp(reports.map(report => report.executionStartTime));
  const executionEndTime = maxTimestamp(reports.map(report => report.executionEndTime));
  const totalDuration = executionStartTime && executionEndTime
    ? new Date(executionEndTime) - new Date(executionStartTime)
    : null;
  const orderOutcomes = reports.flatMap(report => report.orderOutcomes || []);
  const requestDetails = reports.flatMap(report => report.requestDetails || []);
  const bufferFailureDetails = reports.flatMap(report => report.bufferFailureDetails || []);
  const artFailureDetails = reports.flatMap(report => report.artFailureDetails || []);
  const payloadComparisons = reports.flatMap(report => report.payloadComparisons || []);
  const orderProfiles = reports.flatMap(report => report.orderProfiles || []);
  const hasProfiling = reports.some(report => report.summary?.profiling?.enabled || (report.orderProfiles || []).length > 0);
  const profileFallbackTotals = {
    totalProfiledMs: orderProfiles.reduce((sum, profile) => sum + (profile.totalProfiledMs || 0), 0),
    totalWaitMs: orderProfiles.reduce((sum, profile) => sum + (profile.totalWaitMs || 0), 0),
    totalLspServerLatencyMs: orderProfiles.reduce((sum, profile) => sum + (profile.totalLspServerLatencyMs || 0), 0),
    totalLspCalls: orderProfiles.reduce((sum, profile) => sum + (profile.lspServerLatency?.count || 0), 0)
  };
  const allSuccessful = reports.every(report => report.overallStatus === 'SUCCESS');

  return {
    executionId: `art-merged-${Date.now()}`,
    executionStartTime,
    executionEndTime,
    totalDuration,
    overallStatus: allSuccessful ? 'SUCCESS' : 'PARTIAL_FAILURE',
    summary: {
      totalOrders: sumSummary(reports, 'totalOrders'),
      completed: sumSummary(reports, 'completed'),
      skipped: sumSummary(reports, 'skipped'),
      failed: sumSummary(reports, 'failed'),
      stuck: sumSummary(reports, 'stuck'),
      timeout: sumSummary(reports, 'timeout'),
      stopped: sumSummary(reports, 'stopped'),
      replayDecisionFailures: sumSummary(reports, 'replayDecisionFailures'),
      totalArtFailures: sumSummary(reports, 'totalArtFailures'),
      ordersWithArtFailures: sumSummary(reports, 'ordersWithArtFailures'),
      totalFlowFailures: sumSummary(reports, 'totalFlowFailures'),
      ordersWithFlowFailures: sumSummary(reports, 'ordersWithFlowFailures'),
      totalFailedLogs: sumSummary(reports, 'totalFailedLogs'),
      totalTimeoutLogs: sumSummary(reports, 'totalTimeoutLogs'),
      totalBufferFailures: sumSummary(reports, 'totalBufferFailures'),
      ordersWithBufferFailures: sumSummary(reports, 'ordersWithBufferFailures'),
      totalPayloadComparisons: sumSummary(reports, 'totalPayloadComparisons'),
      totalPayloadMismatches: sumSummary(reports, 'totalPayloadMismatches'),
      ...(hasProfiling ? {
        profiling: {
          enabled: true,
          profiledOrders: sumProfilingSummary(reports, 'profiledOrders') || orderProfiles.length,
          totalProfiledMs: sumProfilingSummary(reports, 'totalProfiledMs') || profileFallbackTotals.totalProfiledMs,
          totalWaitMs: sumProfilingSummary(reports, 'totalWaitMs') || profileFallbackTotals.totalWaitMs,
          totalLspServerLatencyMs: sumProfilingSummary(reports, 'totalLspServerLatencyMs') || profileFallbackTotals.totalLspServerLatencyMs,
          totalLspCalls: sumProfilingSummary(reports, 'totalLspCalls') || profileFallbackTotals.totalLspCalls
        }
      } : {})
    },
    orderOutcomes,
    requestDetails,
    bufferFailureDetails,
    artFailureDetails,
    payloadComparisons,
    ...(hasProfiling ? { orderProfiles } : {}),
    workerReports: reports.map((report, index) => ({
      workerIndex: index,
      path: report.workerReportPath,
      executionId: report.executionId,
      overallStatus: report.overallStatus,
      summary: report.summary || {}
    }))
  };
}

async function main() {
  const { outputPath, inputPaths } = parseReportPathArgs();
  const absoluteOutputPath = resolve(process.cwd(), outputPath);
  const reports = await readReports(inputPaths);
  const mergedReport = mergeReports(reports);

  await mkdir(dirname(absoluteOutputPath), { recursive: true });

  try {
    const htmlPath = generateHtmlReport(mergedReport, absoluteOutputPath);
    mergedReport.htmlReportPath = htmlPath;
    console.log(`ART merged HTML report generated: ${htmlPath}`);
  } catch (error) {
    console.warn(`Warning: Could not generate merged HTML report: ${error.message}`);
  }

  try {
    const pdfPath = await generatePdfReport(mergedReport, absoluteOutputPath);
    mergedReport.pdfReportPath = pdfPath;
    console.log(`ART merged PDF report generated: ${pdfPath}`);
  } catch (error) {
    console.warn(`Warning: Could not generate merged PDF report: ${error.message}`);
  }

  await writeFile(absoluteOutputPath, JSON.stringify(mergedReport, null, 2), 'utf-8');
  console.log(`ART merged report generated: ${absoluteOutputPath}`);
  console.log(`Merged ${reports.length} worker report(s), ${mergedReport.summary.totalOrders} order(s)`);
}

main().catch(error => {
  console.error('Failed to merge ART reports:', error.message);
  console.error(error.stack);
  process.exit(1);
});
