import { writeFileSync } from 'fs';
import { resolve } from 'path';
import { generateHtmlReport } from './art-html-report-generator.js';
import { generatePdfReport } from './art-pdf-report-generator.js';

function extractReadableFailureMessage(value) {
  if (!value) {
    return null;
  }

  if (typeof value === 'string') {
    return value;
  }

  if (typeof value !== 'object') {
    return String(value);
  }

  return (
    value.errorMessage ||
    value.error_message ||
    value.description ||
    value.message ||
    value.error ||
    value.code ||
    null
  );
}

export class ArtReportGenerator {
  constructor(config = {}) {
    this.reportPath = config.reportPath || 'report.json';
    this.orders = [];
    this.executionStartTime = null;
    this.executionEndTime = null;
    this.globalBufferFailures = [];
  }

  startExecution() {
    this.executionStartTime = new Date().toISOString();
    this.orders = [];
    this.globalBufferFailures = [];
  }

  addOrder(orderInfo) {
    const orderReport = {
      orderId: orderInfo.orderId,
      merchantId: orderInfo.merchantId,
      orderIndex: orderInfo.orderIndex,
      totalOrders: orderInfo.totalOrders,
      status: 'STARTED',
      startTime: new Date().toISOString(),
      endTime: null,
      duration: null,
      logsProcessed: 0,
      logsTotal: orderInfo.logsTotal || 0,
      currentLogTag: null,
      currentLogIndex: 0,
      errors: [],
      stuckAt: null,
      stopReason: null,
      artResults: {
        passed: 0,
        failed: 0,
        total: 0,
        payloadComparisons: []
      },
      timeline: [],
      bufferFailures: [],
      diagnostics: {
        lastProcessedLog: null,
        timeoutAt: null,
        failureAt: null,
        latestBufferFailure: null,
        replayWarnings: [],
        failedLogs: [],
        failedLogsCount: 0,
        timeoutLogsCount: 0,
        summary: null
      }
    };
    this.orders.push(orderReport);
    return orderReport;
  }

  updateOrderProgress(orderId, progress) {
    const order = this.orders.find(o => o.orderId === orderId);
    if (!order) return;

    if (progress.logTag) {
      order.currentLogTag = progress.logTag;
    }
    if (progress.logIndex !== undefined) {
      order.currentLogIndex = progress.logIndex;
    }
    if (progress.logsProcessed !== undefined) {
      order.logsProcessed = progress.logsProcessed;
    }
    order.diagnostics.lastProcessedLog = {
      timestamp: new Date().toISOString(),
      logTag: order.currentLogTag,
      logIndex: order.currentLogIndex,
      logsProcessed: order.logsProcessed
    };
    if (progress.timeline) {
      order.timeline.push({
        timestamp: new Date().toISOString(),
        ...progress.timeline
      });
    }
  }

  recordOrderError(orderId, error) {
    const order = this.orders.find(o => o.orderId === orderId);
    if (!order) return;

    order.errors.push({
      timestamp: new Date().toISOString(),
      message: error.message || error,
      stack: error.stack,
      step: error.step || 'unknown'
    });
    order.diagnostics.failureAt = {
      timestamp: new Date().toISOString(),
      type: 'ORDER_ERROR',
      logTag: order.currentLogTag,
      logIndex: order.currentLogIndex,
      message: error.message || error,
      step: error.step || 'unknown'
    };
    order.status = 'ERROR';
  }

  markOrderStuck(orderId, stuckInfo) {
    const order = this.orders.find(o => o.orderId === orderId);
    if (!order) return;

    order.stuckAt = {
      timestamp: new Date().toISOString(),
      logTag: stuckInfo.logTag,
      logIndex: stuckInfo.logIndex,
      reason: stuckInfo.reason
    };
    order.diagnostics.timeoutAt = {
      timestamp: new Date().toISOString(),
      logTag: stuckInfo.logTag,
      logIndex: stuckInfo.logIndex,
      reason: stuckInfo.reason
    };
    order.diagnostics.timeoutLogsCount = 1;
    order.status = 'STUCK';
  }

  recordBufferFailure(orderId, failureInfo) {
    const bufferEntry = {
      timestamp: new Date().toISOString(),
      requestId: failureInfo.requestId,
      logTag: failureInfo.logTag,
      sourceDestination: failureInfo.sourceDestination,
      endpoint: failureInfo.endpoint,
      baseUrl: failureInfo.baseUrl,
      requestPayload: failureInfo.requestPayload,
      error: failureInfo.error,
      errorMessage: failureInfo.errorMessage,
      errorCode: failureInfo.errorCode,
      errorStack: failureInfo.errorStack,
      httpStatus: failureInfo.httpStatus,
      responseData: failureInfo.responseData
    };

    this.globalBufferFailures.push({
      orderId,
      ...bufferEntry
    });

    const order = this.orders.find(o => o.orderId === orderId);
    if (order) {
      order.bufferFailures.push(bufferEntry);
      order.diagnostics.latestBufferFailure = bufferEntry;
      order.diagnostics.failureAt = {
        timestamp: bufferEntry.timestamp,
        type: 'BUFFER_FAILURE',
        logTag: bufferEntry.logTag,
        logIndex: order.currentLogIndex,
        endpoint: bufferEntry.endpoint,
        baseUrl: bufferEntry.baseUrl,
        message: bufferEntry.errorMessage || bufferEntry.error || 'Buffer failure'
      };
    }
  }

  getAllBufferFailures() {
    return this.globalBufferFailures;
  }

  getBufferFailuresForOrder(orderId) {
    const order = this.orders.find(o => o.orderId === orderId);
    return order ? order.bufferFailures : [];
  }

  recordReplayWarning(orderId, warningInfo) {
    const order = this.orders.find(o => o.orderId === orderId);
    if (!order) return;

    order.diagnostics.replayWarnings.push({
      timestamp: new Date().toISOString(),
      ...warningInfo
    });
  }

  finalizeOrder(orderId, result) {
    const order = this.orders.find(o => o.orderId === orderId);
    if (!order) return;

    order.endTime = new Date().toISOString();
    order.duration = new Date(order.endTime) - new Date(order.startTime);

    if (result.success) {
      order.status = result.skipped ? 'SKIPPED' : 'COMPLETED';
    } else if (order.status === 'ERROR') {
      order.status = 'ERROR';
    } else if (result.stopReason === 'Stopped by user') {
      order.status = 'STOPPED';
    } else if (result.stopReason?.startsWith('API Failure:')) {
      order.status = 'FAILED';
    } else if (result.stopReason?.startsWith('Timeout:')) {
      order.status = 'TIMEOUT';
    } else {
      order.status = 'FAILED';
    }

    order.stopReason = result.stopReason || (result.success ? 'Completed successfully' : result.error);
    order.errorMessage = result.errorMessage || null;
    order.logsProcessed = result.logsProcessed || order.logsProcessed;
    order.artResults = {
      passed: result.artResults?.passed || 0,
      failed: result.artResults?.failed || 0,
      total: result.artResults?.processedLogs?.length || 0,
      payloadComparisons: result.artResults?.payloadComparisons || []
    };

    const failedLogs = (result.artResults?.errors || []).map(error => ({
      timestamp: error.timestamp || new Date().toISOString(),
      step: error.step || 'unknown',
      entry: error.entry || null,
      details: error.details || null
    }));

    order.diagnostics.failedLogs = failedLogs;
    order.diagnostics.failedLogsCount = failedLogs.length || order.artResults.failed || 0;
    order.diagnostics.timeoutLogsCount = order.diagnostics.timeoutAt ? 1 : 0;

    if (!order.diagnostics.lastProcessedLog && order.currentLogTag) {
      order.diagnostics.lastProcessedLog = {
        timestamp: new Date().toISOString(),
        logTag: order.currentLogTag,
        logIndex: order.currentLogIndex,
        logsProcessed: order.logsProcessed
      };
    }

    if (!order.diagnostics.failureAt && failedLogs.length > 0) {
      const latestFailedLog = failedLogs[failedLogs.length - 1];
      order.diagnostics.failureAt = {
        timestamp: latestFailedLog.timestamp,
        type: 'FAILED_LOG',
        logTag: latestFailedLog.entry,
        logIndex: order.currentLogIndex,
        message:
          extractReadableFailureMessage(latestFailedLog.details)
          || latestFailedLog.step
          || order.stopReason
      };
    } else if (!order.diagnostics.failureAt && order.status === 'FAILED') {
      order.diagnostics.failureAt = {
        timestamp: new Date().toISOString(),
        type: 'FAILED_ORDER',
        logTag: order.currentLogTag,
        logIndex: order.currentLogIndex,
        message:
          order.errorMessage
          || extractReadableFailureMessage(order.bufferFailures?.[order.bufferFailures.length - 1]?.responseData)
          || order.stopReason
      };
    }

    order.diagnostics.summary = {
      lastProcessedLog: order.diagnostics.lastProcessedLog,
      timeoutAt: order.diagnostics.timeoutAt,
      failureAt: order.diagnostics.failureAt,
      latestBufferFailure: order.diagnostics.latestBufferFailure,
      failedLogs: order.diagnostics.failedLogs,
      failedLogsCount: order.diagnostics.failedLogsCount,
      timeoutLogsCount: order.diagnostics.timeoutLogsCount,
      stopReason: order.stopReason,
      errorMessage: order.errorMessage
    };
  }

  completeExecution(overallSuccess) {
    this.executionEndTime = new Date().toISOString();
    this.generateReport(overallSuccess);
  }

  buildOrderOutcome(order) {
    const failurePoint =
      order.diagnostics?.failureAt ||
      order.diagnostics?.timeoutAt ||
      order.diagnostics?.lastProcessedLog ||
      null;

    return {
      orderId: order.orderId,
      status: order.status,
      failureReason:
        order.errorMessage ||
        extractReadableFailureMessage(order.bufferFailures?.[order.bufferFailures.length - 1]?.responseData) ||
        failurePoint?.message ||
        failurePoint?.reason ||
        order.stopReason ||
        null,
      logIndex: failurePoint?.logIndex ?? order.currentLogIndex ?? null,
      logTag: failurePoint?.logTag ?? order.currentLogTag ?? null,
      ...(order.stopReason ? { stopReason: order.stopReason } : {})
    };
  }

  buildRequestDetails(order) {
    return {
      orderId: order.orderId,
      status: order.status,
      failedAt: {
        logIndex:
          order.diagnostics?.failureAt?.logIndex ??
          order.diagnostics?.timeoutAt?.logIndex ??
          order.currentLogIndex ??
          null,
        logTag:
          order.diagnostics?.failureAt?.logTag ??
          order.diagnostics?.timeoutAt?.logTag ??
          order.currentLogTag ??
          null,
        reason:
          order.errorMessage ||
          extractReadableFailureMessage(order.bufferFailures?.[order.bufferFailures.length - 1]?.responseData) ||
          order.diagnostics?.failureAt?.message ||
          order.diagnostics?.timeoutAt?.reason ||
          order.stopReason ||
          null
      },
      requests: (order.bufferFailures || []).map((failure) => ({
        requestId: failure.requestId || null,
        logTag: failure.logTag || null,
        sourceDestination: failure.sourceDestination || null,
        endpoint: failure.endpoint || null,
        baseUrl: failure.baseUrl || null,
        httpStatus: failure.httpStatus || null,
        errorMessage: failure.errorMessage || failure.error || null,
        requestPayload: failure.requestPayload || null,
        responseData: failure.responseData || null
      }))
    };
  }

  buildPayloadComparisons(order) {
    const mismatchedComparisons = (order.artResults?.payloadComparisons || [])
      .filter((comparison) => (comparison.differenceCount || 0) > 0);

    return {
      orderId: order.orderId,
      status: order.status,
      comparisons: mismatchedComparisons.map((comparison) => ({
        timestamp: comparison.timestamp || null,
        logTag: comparison.logTag || null,
        logIndex: comparison.logIndex ?? null,
        entry: comparison.entry || null,
        differenceCount: comparison.differenceCount || 0,
        differences: comparison.differences || []
      }))
    };
  }

  generateReport(overallSuccess) {
    // Finalize any orders that never completed (process terminated mid-run)
    const now = new Date().toISOString();
    for (const order of this.orders) {
      if (order.status === 'STARTED') {
        order.status = 'FAILED';
        order.endTime = now;
        order.duration = new Date(now) - new Date(order.startTime);
        order.stopReason = 'Terminated before order completed';
      }
    }

    const totalBufferFailures = this.globalBufferFailures.length;
    const ordersWithBufferFailures = this.orders.filter(o => o.bufferFailures && o.bufferFailures.length > 0).length;
    const totalFailedLogs = this.orders.reduce((acc, order) => acc + (order.diagnostics?.failedLogsCount || order.artResults?.failed || 0), 0);
    const totalTimeoutLogs = this.orders.reduce((acc, order) => acc + (order.diagnostics?.timeoutLogsCount || 0), 0);
    const totalPayloadComparisons = this.orders.reduce((acc, order) => acc + (order.artResults?.payloadComparisons?.length || 0), 0);
    const totalPayloadMismatches = this.orders.reduce(
      (acc, order) => acc + (order.artResults?.payloadComparisons?.filter((comparison) => (comparison.differenceCount || 0) > 0).length || 0),
      0
    );

    const orderOutcomes = this.orders.map((order) => this.buildOrderOutcome(order));
    const requestDetails = this.orders
      .filter((order) => (order.bufferFailures || []).length > 0)
      .map((order) => this.buildRequestDetails(order));
    const payloadComparisons = this.orders
      .map((order) => this.buildPayloadComparisons(order))
      .filter((order) => order.comparisons.length > 0);

    const report = {
      executionId: `art-${Date.now()}`,
      executionStartTime: this.executionStartTime,
      executionEndTime: this.executionEndTime,
      totalDuration: this.executionEndTime 
        ? new Date(this.executionEndTime) - new Date(this.executionStartTime)
        : null,
      overallStatus: overallSuccess ? 'SUCCESS' : 'PARTIAL_FAILURE',
      summary: {
        totalOrders: this.orders.length,
        completed: this.orders.filter(o => o.status === 'COMPLETED').length,
        skipped: this.orders.filter(o => o.status === 'SKIPPED').length,
        failed: this.orders.filter(o => o.status === 'FAILED' || o.status === 'ERROR').length,
        stuck: this.orders.filter(o => o.status === 'STUCK').length,
        timeout: this.orders.filter(o => o.status === 'TIMEOUT').length,
        stopped: this.orders.filter(o => o.status === 'STOPPED').length,
        totalFailedLogs,
        totalTimeoutLogs,
        totalBufferFailures,
        ordersWithBufferFailures,
        totalPayloadComparisons,
        totalPayloadMismatches
      },
      orderOutcomes,
      requestDetails,
      payloadComparisons
    };

    try {
      const reportPath = resolve(process.cwd(), this.reportPath);

      // Generate HTML first so the path can be embedded in the JSON
      try {
        const htmlPath = generateHtmlReport(report, reportPath);
        report.htmlReportPath = htmlPath;
        console.log(`ART HTML Report generated: ${htmlPath}`);
      } catch (htmlError) {
        console.warn(`Warning: Could not generate HTML report: ${htmlError.message}`);
      }

      // Generate PDF
      generatePdfReport(report, reportPath)
        .then(pdfPath => {
          report.pdfReportPath = pdfPath;
          console.log(`ART PDF Report generated: ${pdfPath}`);
        })
        .catch(pdfError => {
          console.warn(`Warning: Could not generate PDF report: ${pdfError.message}`);
        });

      writeFileSync(reportPath, JSON.stringify(report, null, 2), 'utf-8');
      console.log(`ART Report generated: ${reportPath}`);
      
      if (totalBufferFailures > 0) {
        console.log(`Warning: ${totalBufferFailures} buffer request(s) failed during execution`);
        console.log('Check report.json -> requestDetails for the failed request payloads');
      }
      
      return report;
    } catch (error) {
      console.error('Failed to write report:', error.message);
      return report;
    }
  }

  getCurrentOrder(orderId) {
    return this.orders.find(o => o.orderId === orderId);
  }
}

export default ArtReportGenerator;
