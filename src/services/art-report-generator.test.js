import test from 'node:test';
import assert from 'node:assert/strict';

import { ArtReportGenerator } from './art-report-generator.js';

test('buildOrderOutcome prefers structured flow failure message over generic stop reason', () => {
  const generator = new ArtReportGenerator();
  generator.startExecution();

  const order = generator.addOrder({
    orderId: 'order-1',
    merchantId: 'flipkart',
    orderIndex: 1,
    totalOrders: 1
  });

  order.status = 'FAILED';
  order.currentLogTag = 'GetLenderFlows_REQUEST';
  order.currentLogIndex = 72;
  order.stopReason = 'API Failure: Unknown error';
  order.flowFailures.push({
    responseData: {
      description: 'Product flow not found.',
      code: 'PRODUCT_FLOW_NOT_FOUND'
    }
  });

  const outcome = generator.buildOrderOutcome(order);
  const requestDetails = generator.buildRequestDetails(order);

  assert.equal(outcome.failureReason, 'Product flow not found.');
  assert.equal(requestDetails.failedAt.reason, 'Product flow not found.');
  assert.equal(outcome.failureCategory, 'FLOW_FAILURE');
});

test('finalizeOrder derives buffer failure for expected event timeout', () => {
  const generator = new ArtReportGenerator();
  generator.startExecution();

  generator.addOrder({
    orderId: 'order-2',
    merchantId: 'flipkart',
    orderIndex: 1,
    totalOrders: 1
  });

  generator.finalizeOrder('order-2', {
    success: false,
    stopReason: 'Timeout: Timed out waiting for matching request [3] LSP-Eligibility_REQUEST CORE→GATEWAY',
    logsProcessed: 3,
    artResults: {
      passed: 3,
      failed: 0,
      processedLogs: []
    }
  });

  const outcome = generator.buildOrderOutcome(generator.getCurrentOrder('order-2'));
  assert.equal(outcome.failureCategory, 'BUFFER_FAILURE');
  assert.equal(generator.getBufferFailuresForOrder('order-2').length, 1);
});
