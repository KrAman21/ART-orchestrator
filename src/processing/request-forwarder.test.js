import test from 'node:test';
import assert from 'node:assert/strict';

import { prepareForwardingRequest } from './request-forwarder.js';

test('prepareForwardingRequest preserves CORE->GATEWAY loan status payload requestId from the incoming body', () => {
  const incoming = {
    requestId: 'live-http-request-id',
    headers: {},
    payload: {
      loanApplicationId: 'LSP123',
      requestId: 'stale-replay-body-request-id'
    }
  };

  const expectedEntry = {
    logTag: 'Lsp-LoanStatusRequest_REQUEST',
    sourceDestination: 'CORE_GATEWAY',
    message: {
      merchant_id: 'flipkart'
    }
  };

  const prepared = prepareForwardingRequest(incoming, expectedEntry, {});

  assert.equal(prepared.payload.requestId, 'stale-replay-body-request-id');
  assert.equal(prepared.headers['x-merchant-id'], 'flipkart');
  assert.equal(prepared.merchantId, 'flipkart');
});

test('prepareForwardingRequest preserves non-loan-status request payload requestId', () => {
  const incoming = {
    requestId: 'outer-request-id',
    headers: {},
    payload: {
      requestId: 'payload-request-id'
    }
  };

  const expectedEntry = {
    logTag: 'LSP-Eligibility_REQUEST',
    sourceDestination: 'CORE_GATEWAY',
    message: {
      merchant_id: 'flipkart'
    }
  };

  const prepared = prepareForwardingRequest(incoming, expectedEntry, {});

  assert.equal(prepared.payload.requestId, 'payload-request-id');
  assert.equal(prepared.headers['x-merchant-id'], 'flipkart');
});

test('prepareForwardingRequest keeps incoming merchant header when already present', () => {
  const incoming = {
    requestId: 'live-http-request-id',
    headers: {
      'x-merchant-id': 'flipkartSM'
    },
    payload: {}
  };

  const expectedEntry = {
    logTag: 'Lsp-LoanStatusRequest_REQUEST',
    sourceDestination: 'CORE_GATEWAY',
    message: {
      merchant_id: 'flipkart'
    }
  };

  const prepared = prepareForwardingRequest(incoming, expectedEntry, {});

  assert.equal(prepared.headers['x-merchant-id'], 'flipkartSM');
  assert.equal(prepared.merchantId, 'flipkartSM');
});
