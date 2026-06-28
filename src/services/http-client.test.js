import test from 'node:test';
import assert from 'node:assert/strict';

import { makeRequest } from './http-client.js';

test('makeRequest sends GetLenderFlows APP_CORE payload as text envelope on first attempt', async () => {
  const originalFetch = global.fetch;
  const fetchCalls = [];

  global.fetch = async (url, options = {}) => {
    fetchCalls.push({ url, options });
    return {
      status: 200,
      statusText: 'OK',
      headers: new Map(),
      json: async () => ({ status: 'SUCCESS' })
    };
  };

  try {
    const payload = {
      orderId: 'OD123',
      merchantId: 'flipkart'
    };

    const response = await makeRequest(
      'http://lsp',
      '/api/v4.0/getLenderFlows',
      'POST',
      payload,
      'LSP-request-1',
      'APP_CORE',
      'GetLenderFlows_REQUEST',
      'flipkart',
      {
        'x-merchant-id': 'flipkart',
        'x-order-id': 'OD123'
      }
    );

    assert.equal(response.status, 200);
    assert.equal(fetchCalls.length, 1);

    const firstBody = fetchCalls[0].options.body;
    assert.equal(typeof firstBody, 'string');

    const decodedOuter = JSON.parse(firstBody);
    assert.equal(typeof decodedOuter, 'string');

    const decodedEnvelope = JSON.parse(decodedOuter);
    assert.deepEqual(decodedEnvelope.payload, payload);
    assert.equal(decodedEnvelope.header['X-Merchant-Id'], 'flipkart');
    assert.equal(decodedEnvelope.header['x-order-id'], 'OD123');
    assert.equal(decodedEnvelope.requestId, 'LSP-request-1');
  } finally {
    global.fetch = originalFetch;
  }
});

test('makeRequest sends GetAgreementData APP_CORE payload as text envelope on first attempt', async () => {
  const originalFetch = global.fetch;
  const fetchCalls = [];

  global.fetch = async (url, options = {}) => {
    fetchCalls.push({ url, options });
    return {
      status: 200,
      statusText: 'OK',
      headers: new Map(),
      json: async () => ({ status: 'SUCCESS' })
    };
  };

  try {
    const payload = {
      loanApplicationId: 'LA-OD123-flipkart-DMI',
      offerId: null
    };

    const response = await makeRequest(
      'http://lsp',
      '/api/v3.3/loan/offers/getAgreementData/trigger',
      'POST',
      payload,
      'LSP-request-2',
      'APP_CORE',
      'GetAgreementDataRequest_REQUEST',
      'flipkart',
      {
        'x-merchant-id': 'flipkart',
        'x-order-id': 'OD123',
        'x-session-token': 'session-token-1',
        'x-user-id': 'user-1',
        'x-device-token-id': 'device-1',
        'x-forwarded-for': '127.0.0.1'
      }
    );

    assert.equal(response.status, 200);
    assert.equal(fetchCalls.length, 1);

    const firstBody = fetchCalls[0].options.body;
    assert.equal(typeof firstBody, 'string');

    const decodedOuter = JSON.parse(firstBody);
    assert.equal(typeof decodedOuter, 'string');

    const decodedEnvelope = JSON.parse(decodedOuter);
    assert.deepEqual(decodedEnvelope.payload, payload);
    assert.equal(decodedEnvelope.header['X-Merchant-Id'], 'flipkart');
    assert.equal(decodedEnvelope.header['x-order-id'], 'OD123');
    assert.equal(decodedEnvelope.header['x-session-token'], 'session-token-1');
    assert.equal(decodedEnvelope.header['x-user-id'], 'user-1');
    assert.equal(decodedEnvelope.header['x-device-token-id'], 'device-1');
    assert.equal(decodedEnvelope.header['x-forwarded-for'], '127.0.0.1');
    assert.equal(decodedEnvelope.requestId, 'LSP-request-2');
  } finally {
    global.fetch = originalFetch;
  }
});

test('makeRequest sends SDK wrapper payload as stringified JSON envelope on first attempt', async () => {
  const originalFetch = global.fetch;
  const fetchCalls = [];

  global.fetch = async (url, options = {}) => {
    fetchCalls.push({ url, options });
    return {
      status: 200,
      statusText: 'OK',
      headers: new Map(),
      json: async () => ({ status: 'SUCCESS' })
    };
  };

  try {
    const payload = {
      orderId: 'OD123',
      merchantId: 'flipkart'
    };

    const response = await makeRequest(
      'http://lsp',
      'credit/sdk/fetch/status',
      'POST',
      payload,
      'sdk-request-1',
      'APP_WRAPPER',
      'JuspaySDK-FetchStatus_REQUEST',
      'flipkart',
      {
        'x-origin': 'SDK',
        'x-version': 'V1',
        'x-merchant-id': 'flipkart'
      }
    );

    assert.equal(response.status, 200);
    assert.equal(fetchCalls.length, 1);

    const firstBody = fetchCalls[0].options.body;
    assert.equal(typeof firstBody, 'string');

    const decodedOuter = JSON.parse(firstBody);
    assert.equal(typeof decodedOuter, 'string');

    const decodedEnvelope = JSON.parse(decodedOuter);
    assert.deepEqual(decodedEnvelope.payload, payload);
    assert.equal(decodedEnvelope.header['X-Merchant-Id'], 'flipkart');
    assert.equal(decodedEnvelope.header['x-origin'], 'SDK');
    assert.equal(decodedEnvelope.header['x-version'], 'V1');
    assert.equal(decodedEnvelope.requestId, 'sdk-request-1');
  } finally {
    global.fetch = originalFetch;
  }
});
