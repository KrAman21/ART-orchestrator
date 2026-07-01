import test from 'node:test';
import assert from 'node:assert/strict';

import { NonBlockingHttpClient } from './non-blocking-http.js';

test('recordFailure keeps structured API error description and code', () => {
  const recordedFailures = [];
  const reportGenerator = {
    recordFlowFailure(orderId, failureInfo) {
      recordedFailures.push({ orderId, failureInfo });
    }
  };

  const client = new NonBlockingHttpClient({}, reportGenerator, 'order-1');

  client.recordFailure(
    {
      logTag: 'GetLenderFlows_REQUEST',
      sourceDestination: 'APP_CORE',
      endpoint: '/api/v4.0/getLenderFlows',
      baseUrl: 'http://lsp',
      payload: { orderId: 'order-1' }
    },
    'req-1',
    {
      status: 500,
      data: {
        description: 'Product flow not found.',
        code: 'PRODUCT_FLOW_NOT_FOUND'
      }
    },
    null,
    null
  );

  assert.equal(client.failedRequests[0]?.errorMessage, 'Product flow not found.');
  assert.equal(client.failedRequests[0]?.errorCode, 'PRODUCT_FLOW_NOT_FOUND');
  assert.equal(recordedFailures[0]?.failureInfo.errorMessage, 'Product flow not found.');
  assert.equal(recordedFailures[0]?.failureInfo.errorCode, 'PRODUCT_FLOW_NOT_FOUND');
});
