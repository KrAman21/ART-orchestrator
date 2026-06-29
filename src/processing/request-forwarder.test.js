import test from 'node:test';
import assert from 'node:assert/strict';

import { prepareForwardingRequest, RequestForwarder } from './request-forwarder.js';
import { StateManager } from '../services/state-manager.js';

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

test('prepareForwardingRequest rewrites outgoing payload and header loan application ids using latest replay loan application id', () => {
  const stateManager = new StateManager();
  stateManager.seedProdLoanApplicationIdsFromLogs([
    {
      payload: {
        loanApplicationId: 'prod-la-1'
      }
    }
  ]);
  stateManager.setCurrentReplayLoanApplicationId('live-la-1', { logTag: 'LSP-Eligibility_REQUEST' });

  const incoming = {
    requestId: 'live-http-request-id',
    headers: {
      'x-loan-application-id': 'prod-la-1'
    },
    payload: {
      loanApplicationId: 'prod-la-1',
      nested: {
        loan_application_id: 'prod-la-1'
      }
    }
  };

  const expectedEntry = {
    logTag: 'LSP-Eligibility_REQUEST',
    sourceDestination: 'CORE_GATEWAY',
    message: {
      merchant_id: 'flipkart'
    }
  };

  const prepared = prepareForwardingRequest(incoming, expectedEntry, {}, stateManager);

  assert.equal(prepared.headers['x-loan-application-id'], 'live-la-1');
  assert.equal(prepared.payload.loanApplicationId, 'live-la-1');
  assert.equal(prepared.payload.nested.loan_application_id, 'live-la-1');
});

test('prepareForwardingRequest rewrites top-level and nested request ids using owner logTag replay mapping', () => {
  const stateManager = new StateManager();
  stateManager.seedProdRequestIdsFromLogs([
    {
      logTag: 'LSP-Eligibility_REQUEST',
      payload: {
        requestId: 'prod-req-1'
      }
    }
  ]);
  stateManager.setReplayRequestIdForLogTag('LSP-Eligibility_REQUEST', 'live-req-1');

  const incoming = {
    requestId: 'prod-req-1',
    headers: {
      'x-request-id': 'prod-req-1'
    },
    payload: {
      requestId: 'prod-req-1',
      nested: {
        request_id: 'prod-req-1'
      }
    }
  };

  const expectedEntry = {
    logTag: 'LSP-Eligibility_REQUEST',
    sourceDestination: 'CORE_GATEWAY',
    message: {
      merchant_id: 'flipkart'
    }
  };

  const prepared = prepareForwardingRequest(incoming, expectedEntry, {}, stateManager);

  assert.equal(prepared.requestId, 'live-req-1');
  assert.equal(prepared.headers['x-request-id'], 'live-req-1');
  assert.equal(prepared.payload.requestId, 'live-req-1');
  assert.equal(prepared.payload.nested.request_id, 'live-req-1');
});

test('prepareForwardingRequest adds SDK headers when log tag contains SDK', () => {
  const incoming = {
    requestId: 'outer-request-id',
    headers: {},
    payload: {}
  };

  const expectedEntry = {
    logTag: 'LSP-LoanStatus_SDK_REQUEST',
    sourceDestination: 'CORE_GATEWAY',
    message: {
      merchant_id: 'flipkart'
    }
  };

  const prepared = prepareForwardingRequest(incoming, expectedEntry, {});

  assert.equal(prepared.headers['x-origin'], 'SDK');
  assert.equal(prepared.headers['x-version'], 'V1');
});

test('RequestForwarder tolerates configured blocking forward timeout using replay fallback response', () => {
  const validator = {
    processedIndices: new Set(),
    markProcessed(entry) {
      this.processedIndices.add(entry.index);
    }
  };
  const stateManager = new StateManager();
  stateManager.seedProdRequestIdsFromLogs([
    {
      logTag: 'GetAgreementDataRequest-LSP_REQUEST',
      payload: {
        requestId: 'prod-callback-request-id'
      }
    }
  ]);
  stateManager.setReplayRequestIdForLogTag(
    'GetAgreementDataRequest-LSP_REQUEST',
    'live-callback-request-id'
  );
  const loggedOutgoing = [];
  const successes = [];

  const forwarder = new RequestForwarder({
    validator,
    stateManager,
    logger: {
      warn() {},
      info() {},
      logOutgoing(...args) {
        loggedOutgoing.push(args);
      }
    },
    config: {},
    callbacks: {
      getServiceBaseUrl: () => 'http://gateway',
      buildFailureFallbackResponse: () => ({
        reason: 'tolerated_batch_timeout_replay_response_fallback',
        response: {
          status: 200,
          statusText: 'OK',
          headers: { 'content-type': 'application/json' },
          data: {
            status: 'SUCCESS',
            agreementUrl: 'https://example.test/agreement',
            trace_response: {
              requestId: 'prod-callback-request-id'
            }
          }
        }
      }),
      comparePayloads: () => ({ match: true, differences: {} }),
      recordSuccess(step, entry) {
        successes.push({ step, entry });
      }
    }
  });

  const incoming = {
    source: 'CORE',
    destination: 'GATEWAY',
    requestId: 'req-1'
  };
  const expectedEntry = {
    index: 32,
    logTag: 'GetAgreementDataRequest-LSP_REQUEST',
    sourceDestination: 'CORE_GATEWAY',
    loanApplicationId: 'loan-1',
    lenderOrgId: 'DMI',
    toString() {
      return '[32] GetAgreementDataRequest-LSP_REQUEST CORE→GATEWAY';
    }
  };
  const expectedResponse = {
    index: 53,
    logTag: 'GetAgreementDataRequest-LSP_RESPONSE',
    payload: { status: 'SUCCESS', agreementUrl: 'https://example.test/agreement' },
    toString() {
      return '[53] GetAgreementDataRequest-LSP_RESPONSE GATEWAY→CORE';
    }
  };

  const result = forwarder.tryBuildFailureFallbackResult({
    incoming,
    expectedEntry,
    expectedResponse,
    correlationKey: 'corr-1',
    destination: 'GATEWAY',
    endpoint: '/gateway/v3.3/loan/getLoanAgreementRequest',
    transformedPayload: { loanApplicationId: 'loan-1' },
    serviceResponse: {
      error: true,
      message: 'Request timeout',
      status: 0,
      statusText: null
    },
    apiFailure: null
  });

  assert.deepEqual(result, {
    success: true,
    payload: {
      status: 'SUCCESS',
      agreementUrl: 'https://example.test/agreement',
      trace_response: {
        requestId: 'live-callback-request-id'
      }
    },
    headers: { 'content-type': 'application/json' }
  });
  assert.equal(validator.processedIndices.has(53), true);
  assert.equal(successes.length, 1);
  assert.equal(successes[0].step, 'downstream_response_validation');
  assert.equal(stateManager.getResponseHeaders('corr-1')['content-type'], 'application/json');
  assert.deepEqual(stateManager.pendingResponses.get('corr-1'), {
    status: 'SUCCESS',
    agreementUrl: 'https://example.test/agreement',
    trace_response: {
      requestId: 'live-callback-request-id'
    }
  });
  assert.equal(loggedOutgoing.length, 1);
  assert.equal(loggedOutgoing[0][4].event, 'forward_failed_tolerated');
});
