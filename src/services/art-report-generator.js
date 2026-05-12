import { writeFileSync } from 'fs';
import { resolve } from 'path';

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
        total: 0
      },
      timeline: [],
      bufferFailures: []
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
    }
  }

  getAllBufferFailures() {
    return this.globalBufferFailures;
  }

  getBufferFailuresForOrder(orderId) {
    const order = this.orders.find(o => o.orderId === orderId);
    return order ? order.bufferFailures : [];
  }

  finalizeOrder(orderId, result) {
    const order = this.orders.find(o => o.orderId === orderId);
    if (!order) return;

    order.endTime = new Date().toISOString();
    order.duration = new Date(order.endTime) - new Date(order.startTime);
    order.status = result.success ? 'COMPLETED' : (order.status === 'ERROR' ? 'ERROR' : 'TIMEOUT');
    order.stopReason = result.stopReason || (result.success ? 'Completed successfully' : result.error);
    order.logsProcessed = result.logsProcessed || order.logsProcessed;
    order.artResults = {
      passed: result.artResults?.passed || 0,
      failed: result.artResults?.failed || 0,
      total: result.artResults?.processedLogs?.length || 0
    };
  }

  completeExecution(overallSuccess) {
    this.executionEndTime = new Date().toISOString();
    this.generateReport(overallSuccess);
  }

  generateReport(overallSuccess) {
    const totalBufferFailures = this.globalBufferFailures.length;
    const ordersWithBufferFailures = this.orders.filter(o => o.bufferFailures && o.bufferFailures.length > 0).length;

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
        failed: this.orders.filter(o => o.status === 'ERROR').length,
        stuck: this.orders.filter(o => o.status === 'STUCK').length,
        timeout: this.orders.filter(o => o.status === 'TIMEOUT').length,
        totalBufferFailures,
        ordersWithBufferFailures
      },
      bufferFailuresSummary: {
        totalFailures: totalBufferFailures,
        failuresByOrder: this.orders.reduce((acc, order) => {
          if (order.bufferFailures && order.bufferFailures.length > 0) {
            acc[order.orderId] = {
              count: order.bufferFailures.length,
              failures: order.bufferFailures
            };
          }
          return acc;
        }, {}),
        allFailures: this.globalBufferFailures
      },
      orders: this.orders
    };

    try {
      const reportPath = resolve(process.cwd(), this.reportPath);
      writeFileSync(reportPath, JSON.stringify(report, null, 2), 'utf-8');
      console.log(`\n📊 ART Report generated: ${reportPath}`);
      
      if (totalBufferFailures > 0) {
        console.log(`⚠️  Warning: ${totalBufferFailures} buffer request(s) failed during execution`);
        console.log(`   Check report.json -> bufferFailuresSummary for details`);
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
