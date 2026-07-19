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

function isExpectedEventMissingReason(reason) {
  return typeof reason === 'string' && reason.includes('Timed out waiting for matching request');
}

function buildFailureEntry(failureInfo = {}) {
  return {
    timestamp: failureInfo.timestamp || new Date().toISOString(),
    requestId: failureInfo.requestId || null,
    logTag: failureInfo.logTag || null,
    sourceDestination: failureInfo.sourceDestination || null,
    endpoint: failureInfo.endpoint || null,
    baseUrl: failureInfo.baseUrl || null,
    requestPayload: failureInfo.requestPayload || null,
    error: failureInfo.error,
    errorMessage: failureInfo.errorMessage || failureInfo.message || null,
    errorCode: failureInfo.errorCode || failureInfo.code || null,
    errorStack: failureInfo.errorStack || failureInfo.stack || null,
    httpStatus: failureInfo.httpStatus || null,
    responseData: failureInfo.responseData || null,
    failureType: failureInfo.failureType || null,
    step: failureInfo.step || null,
    details: failureInfo.details || null
  };
}

function formatMs(value) {
  return `${Math.round(value || 0)}ms`;
}

function sanitizeComparisonDifferences(logTag, differences = []) {
  return (differences || []).filter((difference) => {
    if (!difference) {
      return false;
    }

    if (
      logTag === 'FECTH_LOAN_APPLICATION_DATA_API_RESPONSE' &&
      difference.path === 'status' &&
      difference.expected === '<missing>' &&
      difference.actual === 'SUCCESS' &&
      difference.reason === 'extra key in actual'
    ) {
      return false;
    }

    if (
      logTag === 'WEBHOOK_RESPONSE' &&
      difference.path === 'status' &&
      difference.expected === '<missing>' &&
      difference.actual === 'SUCCESS' &&
      difference.reason === 'extra key in actual'
    ) {
      return false;
    }

    return true;
  });
}

export class ArtReportGenerator {
  constructor(config = {}) {
    this.reportPath = config.reportPath || 'report.json';
    this.enableOrderProfiling = config.enableOrderProfiling === true;
    this.orders = [];
    this.executionStartTime = null;
    this.executionEndTime = null;
    this.globalArtFailures = [];
    this.globalFlowFailures = [];
    this.globalBufferFailures = [];
    this.reportGenerated = false;
  }

  startExecution() {
    this.executionStartTime = new Date().toISOString();
    this.orders = [];
    this.globalArtFailures = [];
    this.globalFlowFailures = [];
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
      processingTimeMs: null,
      logsProcessed: 0,
      logsTotal: orderInfo.logsTotal || 0,
      currentLogTag: null,
      currentLogIndex: 0,
      errors: [],
      stuckAt: null,
      stopReason: null,
      errorMessage: null,
      artResults: {
        passed: 0,
        failed: 0,
        total: 0,
        payloadComparisons: []
      },
      timeline: [],
      artFailures: [],
      flowFailures: [],
      bufferFailures: [],
      fallbackRecoveries: [],
      unexpectedActualApis: [],
      diagnostics: {
        lastProcessedLog: null,
        timeoutAt: null,
        failureAt: null,
        latestArtFailure: null,
        latestFlowFailure: null,
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

  recordArtFailure(orderId, failureInfo) {
    const artEntry = buildFailureEntry({
      ...failureInfo,
      failureType: failureInfo.failureType || 'ART_FAILURE'
    });

    this.globalArtFailures.push({ orderId, ...artEntry });

    const order = this.orders.find(o => o.orderId === orderId);
    if (!order) return;

    order.artFailures.push(artEntry);
    order.diagnostics.latestArtFailure = artEntry;
    order.diagnostics.failureAt = {
      timestamp: artEntry.timestamp,
      type: 'ART_FAILURE',
      logTag: artEntry.logTag,
      logIndex: order.currentLogIndex,
      endpoint: artEntry.endpoint,
      baseUrl: artEntry.baseUrl,
      message: artEntry.errorMessage || artEntry.error || 'ART failure'
    };
  }

  recordFlowFailure(orderId, failureInfo) {
    const flowEntry = buildFailureEntry({
      ...failureInfo,
      failureType: failureInfo.failureType || 'FLOW_FAILURE'
    });

    this.globalFlowFailures.push({ orderId, ...flowEntry });

    const order = this.orders.find(o => o.orderId === orderId);
    if (!order) return;

    order.flowFailures.push(flowEntry);
    order.diagnostics.latestFlowFailure = flowEntry;
    order.diagnostics.failureAt = {
      timestamp: flowEntry.timestamp,
      type: 'FLOW_FAILURE',
      logTag: flowEntry.logTag,
      logIndex: order.currentLogIndex,
      endpoint: flowEntry.endpoint,
      baseUrl: flowEntry.baseUrl,
      message: flowEntry.errorMessage || flowEntry.error || 'Flow failure'
    };
  }

  recordBufferFailure(orderId, failureInfo) {
    const bufferEntry = buildFailureEntry({
      ...failureInfo,
      failureType: failureInfo.failureType || 'BUFFER_FAILURE'
    });

    this.globalBufferFailures.push({ orderId, ...bufferEntry });

    const order = this.orders.find(o => o.orderId === orderId);
    if (!order) return;

    order.bufferFailures.push(bufferEntry);
    order.diagnostics.latestBufferFailure = bufferEntry;
    order.diagnostics.failureAt = {
      timestamp: bufferEntry.timestamp,
      type: 'BUFFER_FAILURE',
      logTag: bufferEntry.logTag,
      logIndex: order.currentLogIndex,
      endpoint: bufferEntry.endpoint,
      baseUrl: bufferEntry.baseUrl,
      message: bufferEntry.errorMessage || bufferEntry.error || 'Expected event missing'
    };
  }

  getAllBufferFailures() {
    return this.globalBufferFailures;
  }

  getBufferFailuresForOrder(orderId) {
    const order = this.orders.find(o => o.orderId === orderId);
    return order ? order.bufferFailures : [];
  }

  getFlowFailuresForOrder(orderId) {
    const order = this.orders.find(o => o.orderId === orderId);
    return order ? order.flowFailures : [];
  }

  getArtFailuresForOrder(orderId) {
    const order = this.orders.find(o => o.orderId === orderId);
    return order ? order.artFailures : [];
  }

  recordReplayWarning(orderId, warningInfo) {
    const order = this.orders.find(o => o.orderId === orderId);
    if (!order) return;

    order.diagnostics.replayWarnings.push({
      timestamp: new Date().toISOString(),
      ...warningInfo
    });
  }

  recordFallbackRecovery(orderId, recoveryInfo) {
    const order = this.orders.find(o => o.orderId === orderId);
    if (!order) return;

    order.fallbackRecoveries.push({
      timestamp: new Date().toISOString(),
      ...recoveryInfo
    });
  }

  recordUnexpectedActualApi(orderId, apiInfo) {
    const order = this.orders.find(o => o.orderId === orderId);
    if (!order) return;

    order.unexpectedActualApis.push({
      timestamp: new Date().toISOString(),
      ...apiInfo
    });
  }

  finalizeOrder(orderId, result) {
    const order = this.orders.find(o => o.orderId === orderId);
    if (!order) return;

    order.endTime = new Date().toISOString();
    order.duration = new Date(order.endTime) - new Date(order.startTime);
    order.processingTimeMs = order.duration;
    if (this.enableOrderProfiling && result.orderProfile) {
      order.orderProfile = result.orderProfile;
      const lspLatency = result.orderProfile.lspServerLatency || {};
      console.log(
        [
          `ART_ORDER_PROFILE orderId=${orderId}`,
          `total=${formatMs(result.orderProfile.totalProfiledMs)}`,
          `wait=${formatMs(result.orderProfile.totalWaitMs)}`,
          `lspLatency=${formatMs(result.orderProfile.totalLspServerLatencyMs)}`,
          `lspCalls=${lspLatency.count || 0}`,
          `lspAvg=${formatMs(lspLatency.avgMs)}`,
          `lspP95=${formatMs(lspLatency.p95Ms)}`
        ].join(' ')
      );
    }

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

    if (
      !result.success &&
      order.bufferFailures.length === 0 &&
      isExpectedEventMissingReason(order.stopReason)
    ) {
      this.recordBufferFailure(orderId, {
        logTag: order.currentLogTag,
        error: true,
        errorMessage: order.stopReason,
        failureType: 'EXPECTED_EVENT_MISSING',
        details: {
          stopReason: order.stopReason
        }
      });
    }

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
          extractReadableFailureMessage(latestFailedLog.details) ||
          latestFailedLog.step ||
          order.stopReason
      };
    } else if (!order.diagnostics.failureAt && order.status === 'FAILED') {
      order.diagnostics.failureAt = {
        timestamp: new Date().toISOString(),
        type: 'FAILED_ORDER',
        logTag: order.currentLogTag,
        logIndex: order.currentLogIndex,
        message:
          order.errorMessage ||
          extractReadableFailureMessage(order.flowFailures?.[order.flowFailures.length - 1]?.responseData) ||
          extractReadableFailureMessage(order.bufferFailures?.[order.bufferFailures.length - 1]?.responseData) ||
          order.stopReason
      };
    }

    order.diagnostics.summary = {
      lastProcessedLog: order.diagnostics.lastProcessedLog,
      timeoutAt: order.diagnostics.timeoutAt,
      failureAt: order.diagnostics.failureAt,
      latestArtFailure: order.diagnostics.latestArtFailure,
      latestFlowFailure: order.diagnostics.latestFlowFailure,
      latestBufferFailure: order.diagnostics.latestBufferFailure,
      failedLogs: order.diagnostics.failedLogs,
      failedLogsCount: order.diagnostics.failedLogsCount,
      timeoutLogsCount: order.diagnostics.timeoutLogsCount,
      stopReason: order.stopReason,
      errorMessage: order.errorMessage
    };
  }

  completeExecution(overallSuccess) {
    if (this.reportGenerated) {
      return;
    }
    this.executionEndTime = new Date().toISOString();
    this.generateReport(overallSuccess);
  }

  writePartialFailureReport(reason) {
    if (this.reportGenerated) {
      return;
    }

    const failureReason = reason || 'Execution terminated unexpectedly';
    const now = new Date().toISOString();

    for (const order of this.orders) {
      if (order.status === 'STARTED') {
        order.status = 'FAILED';
        order.endTime = now;
        order.duration = new Date(now) - new Date(order.startTime);
        order.processingTimeMs = order.duration;
        if (this.enableOrderProfiling && !order.orderProfile) {
          order.orderProfile = null;
        }
        order.stopReason = failureReason;
        order.errorMessage = failureReason;
        this.recordArtFailure(order.orderId, {
          error: true,
          errorMessage: failureReason,
          failureType: 'PROCESS_FAILURE'
        });
      }

      if (!order.diagnostics.failureAt && order.status !== 'COMPLETED' && order.status !== 'SKIPPED') {
        order.diagnostics.failureAt = {
          timestamp: now,
          type: 'PROCESS_FAILURE',
          logTag: order.currentLogTag,
          logIndex: order.currentLogIndex,
          message: failureReason
        };
      }
    }

    this.executionEndTime = now;
    this.generateReport(false);
  }

  classifyFailureCategory(order) {
    if (order.bufferFailures.length > 0 || order.status === 'TIMEOUT' || order.status === 'STUCK') {
      return 'BUFFER_FAILURE';
    }

    if (order.flowFailures.length > 0 || (order.artResults?.failed || 0) > 0) {
      return 'FLOW_FAILURE';
    }

    if (order.artFailures.length > 0 || order.status === 'ERROR' || order.status === 'FAILED') {
      return 'ART_FAILURE';
    }

    return null;
  }

  countsTowardReplayDecision(order) {
    const category = this.classifyFailureCategory(order);
    return category === 'FLOW_FAILURE' || category === 'BUFFER_FAILURE';
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
      processingTimeMs: order.processingTimeMs,
      ...(this.enableOrderProfiling && order.orderProfile ? {
        totalProfiledMs: order.orderProfile.totalProfiledMs,
        totalWaitMs: order.orderProfile.totalWaitMs,
        totalLspServerLatencyMs: order.orderProfile.totalLspServerLatencyMs
      } : {}),
      failureCategory: this.classifyFailureCategory(order),
      countsTowardReplayDecision: this.countsTowardReplayDecision(order),
      failureReason:
        order.errorMessage ||
        extractReadableFailureMessage(order.flowFailures?.[order.flowFailures.length - 1]?.responseData) ||
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
      processingTimeMs: order.processingTimeMs,
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
          extractReadableFailureMessage(order.flowFailures?.[order.flowFailures.length - 1]?.responseData) ||
          order.diagnostics?.failureAt?.message ||
          order.diagnostics?.timeoutAt?.reason ||
          order.stopReason ||
          null
      },
      requests: (order.flowFailures || []).map((failure) => ({
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

  buildBufferFailureDetails(order) {
    return {
      orderId: order.orderId,
      status: order.status,
      processingTimeMs: order.processingTimeMs,
      failedAt: {
        logIndex:
          order.diagnostics?.timeoutAt?.logIndex ??
          order.diagnostics?.failureAt?.logIndex ??
          order.currentLogIndex ??
          null,
        logTag:
          order.diagnostics?.timeoutAt?.logTag ??
          order.diagnostics?.failureAt?.logTag ??
          order.currentLogTag ??
          null,
        reason:
          order.diagnostics?.timeoutAt?.reason ||
          order.diagnostics?.failureAt?.message ||
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

  buildArtFailureDetails(order) {
    return {
      orderId: order.orderId,
      status: order.status,
      processingTimeMs: order.processingTimeMs,
      failedAt: {
        logIndex:
          order.diagnostics?.failureAt?.logIndex ??
          order.currentLogIndex ??
          null,
        logTag:
          order.diagnostics?.failureAt?.logTag ??
          order.currentLogTag ??
          null,
        reason:
          order.errorMessage ||
          order.diagnostics?.failureAt?.message ||
          order.stopReason ||
          null
      },
      requests: (order.artFailures || []).map((failure) => ({
        requestId: failure.requestId || null,
        logTag: failure.logTag || null,
        sourceDestination: failure.sourceDestination || null,
        endpoint: failure.endpoint || null,
        baseUrl: failure.baseUrl || null,
        httpStatus: failure.httpStatus || null,
        errorMessage: failure.errorMessage || failure.error || null,
        requestPayload: failure.requestPayload || null,
        responseData: failure.responseData || null,
        step: failure.step || null
      }))
    };
  }

  buildPayloadComparisons(order) {
    const mismatchedComparisons = (order.artResults?.payloadComparisons || [])
      .map((comparison) => {
        const differences = sanitizeComparisonDifferences(
          comparison.logTag || null,
          comparison.differences || []
        );

        return {
          ...comparison,
          differences,
          differenceCount: differences.length
        };
      })
      .filter((comparison) => (comparison.differenceCount || 0) > 0);

    return {
      orderId: order.orderId,
      status: order.status,
      processingTimeMs: order.processingTimeMs,
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

  buildUnexpectedActualApis(order) {
    return {
      orderId: order.orderId,
      status: order.status,
      apis: (order.unexpectedActualApis || []).map((api) => ({
        timestamp: api.timestamp || null,
        logTag: api.logTag || null,
        sourceDestination: api.sourceDestination || null,
        source: api.source || null,
        destination: api.destination || null,
        endpoint: api.endpoint || null,
        requestId: api.requestId || null,
        currentReplayEntry: api.currentReplayEntry || null,
        lookaheadWindow: api.lookaheadWindow || [],
        reason: api.reason || null
      }))
    };
  }

  generateReport(overallSuccess) {
    if (this.reportGenerated) {
      return null;
    }

    const now = new Date().toISOString();
    for (const order of this.orders) {
      if (order.status === 'STARTED') {
        order.status = 'FAILED';
        order.endTime = now;
        order.duration = new Date(now) - new Date(order.startTime);
        order.processingTimeMs = order.duration;
        order.stopReason = 'Terminated before order completed';
        this.recordArtFailure(order.orderId, {
          error: true,
          errorMessage: order.stopReason,
          failureType: 'TERMINATED_BEFORE_COMPLETION'
        });
      }
    }

    const totalArtFailures = this.globalArtFailures.length;
    const ordersWithArtFailures = this.orders.filter(o => (o.artFailures || []).length > 0).length;
    const totalFlowFailures = this.globalFlowFailures.length;
    const ordersWithFlowFailures = this.orders.filter(o => (o.flowFailures || []).length > 0).length;
    const totalBufferFailures = this.globalBufferFailures.length;
    const ordersWithBufferFailures = this.orders.filter(o => (o.bufferFailures || []).length > 0).length;
    const totalFailedLogs = this.orders.reduce((acc, order) => acc + (order.diagnostics?.failedLogsCount || order.artResults?.failed || 0), 0);
    const totalTimeoutLogs = this.orders.reduce((acc, order) => acc + (order.diagnostics?.timeoutLogsCount || 0), 0);
    const totalPayloadComparisons = this.orders.reduce((acc, order) => acc + (order.artResults?.payloadComparisons?.length || 0), 0);
    const totalPayloadMismatches = this.orders.reduce(
      (acc, order) => acc + (order.artResults?.payloadComparisons?.filter((comparison) => (comparison.differenceCount || 0) > 0).length || 0),
      0
    );
    const totalFallbackRecoveries = this.orders.reduce((acc, order) => acc + (order.fallbackRecoveries?.length || 0), 0);
    const totalUnexpectedActualApis = this.orders.reduce((acc, order) => acc + (order.unexpectedActualApis?.length || 0), 0);

    const orderOutcomes = this.orders.map((order) => this.buildOrderOutcome(order));
    const replayDecisionFailures = orderOutcomes.filter((order) =>
      order.countsTowardReplayDecision &&
      order.status !== 'COMPLETED' &&
      order.status !== 'SKIPPED' &&
      order.status !== 'STOPPED'
    ).length;

    const requestDetails = this.orders
      .filter((order) => (order.flowFailures || []).length > 0)
      .map((order) => this.buildRequestDetails(order));
    const bufferFailureDetails = this.orders
      .filter((order) => (order.bufferFailures || []).length > 0)
      .map((order) => this.buildBufferFailureDetails(order));
    const artFailureDetails = this.orders
      .filter((order) => (order.artFailures || []).length > 0)
      .map((order) => this.buildArtFailureDetails(order));
    const payloadComparisons = this.orders
      .map((order) => this.buildPayloadComparisons(order))
      .filter((order) => order.comparisons.length > 0);
    const unexpectedActualApis = this.orders
      .map((order) => this.buildUnexpectedActualApis(order))
      .filter((order) => order.apis.length > 0);

    const report = {
      executionId: `art-${Date.now()}`,
      executionStartTime: this.executionStartTime,
      executionEndTime: this.executionEndTime,
      totalDuration: this.executionEndTime
        ? new Date(this.executionEndTime) - new Date(this.executionStartTime)
        : null,
      overallStatus: replayDecisionFailures === 0 ? 'SUCCESS' : 'PARTIAL_FAILURE',
      summary: {
        totalOrders: this.orders.length,
        completed: this.orders.filter(o => o.status === 'COMPLETED').length,
        skipped: this.orders.filter(o => o.status === 'SKIPPED').length,
        failed: this.orders.filter(o => o.status === 'FAILED' || o.status === 'ERROR').length,
        stuck: this.orders.filter(o => o.status === 'STUCK').length,
        timeout: this.orders.filter(o => o.status === 'TIMEOUT').length,
        stopped: this.orders.filter(o => o.status === 'STOPPED').length,
        replayDecisionFailures,
        totalArtFailures,
        ordersWithArtFailures,
        totalFlowFailures,
        ordersWithFlowFailures,
        totalFailedLogs,
        totalTimeoutLogs,
        totalBufferFailures,
        ordersWithBufferFailures,
        totalFallbackRecoveries,
        totalPayloadComparisons,
        totalPayloadMismatches,
        totalUnexpectedActualApis
      },
      orderOutcomes,
      requestDetails,
      payloadComparisons,
      unexpectedActualApis
    };

    try {
      const reportPath = resolve(process.cwd(), this.reportPath);

      try {
        const htmlPath = generateHtmlReport(report, reportPath);
        report.htmlReportPath = htmlPath;
        console.log(`ART HTML Report generated: ${htmlPath}`);
      } catch (htmlError) {
        console.warn(`Warning: Could not generate HTML report: ${htmlError.message}`);
      }

      generatePdfReport(report, reportPath)
        .then(pdfPath => {
          report.pdfReportPath = pdfPath;
          console.log(`ART PDF Report generated: ${pdfPath}`);
        })
        .catch(pdfError => {
          console.warn(`Warning: Could not generate PDF report: ${pdfError.message}`);
        });

      writeFileSync(reportPath, JSON.stringify(report, null, 2), 'utf-8');
      this.reportGenerated = true;
      console.log(`ART Report generated: ${reportPath}`);

      if (totalArtFailures > 0 || totalFlowFailures > 0 || totalBufferFailures > 0) {
        console.log(`Failure summary: ART=${totalArtFailures}, FLOW=${totalFlowFailures}, BUFFER=${totalBufferFailures}`);
        console.log('Check report.json -> artFailureDetails, requestDetails, and bufferFailureDetails for details');
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
