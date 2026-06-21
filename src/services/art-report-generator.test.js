import test from 'node:test';
import assert from 'node:assert/strict';

import { ArtReportGenerator } from './art-report-generator.js';

test('buildOrderOutcome prefers structured buffer failure message over generic stop reason', () => {
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
  order.bufferFailures.push({
    responseData: {
      description: 'Product flow not found.',
      code: 'PRODUCT_FLOW_NOT_FOUND'
    }
  });

  const outcome = generator.buildOrderOutcome(order);
  const requestDetails = generator.buildRequestDetails(order);

  assert.equal(outcome.failureReason, 'Product flow not found.');
  assert.equal(requestDetails.failedAt.reason, 'Product flow not found.');
});
