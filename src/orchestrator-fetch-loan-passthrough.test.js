import test from 'node:test';
import assert from 'node:assert/strict';

import { ReplayOrchestrator } from './orchestrator.js';
import { RetryHandler } from './incoming-handlers/retry-handler.js';

test('maybePassThroughFetchLoanApplicationData defers early fetch-loan-application request when replay is still on a different entry', async () => {
  const orchestrator = Object.create(ReplayOrchestrator.prototype);
  orchestrator.validator = {
    getCurrentEntry() {
      return {
        source: 'CORE',
        destination: 'GATEWAY',
        logTag: 'Lsp-LoanStatusRequest_REQUEST',
        toString() {
          return '[91] Lsp-LoanStatusRequest_REQUEST CORE→GATEWAY';
        }
      };
    }
  };

  const result = await orchestrator.maybePassThroughFetchLoanApplicationData({
    source: 'GATEWAY',
    destination: 'LSP',
    api: '/api/fetch/loanApplicationData',
    logTag: 'FECTH_LOAN_APPLICATION_DATA_API_REQUEST',
    requestId: 'LSPb19d26add1ac48569de01a9a70d2c39c',
    payload: {
      loanApplicationId: 'LSP60fb502cc74d4b9f9d61409d16b62f9f',
      requestId: 'LSPb19d26add1ac48569de01a9a70d2c39c',
      requiredData: ['CUSTOMER_AND_LOAN_DATA'],
      lineId: null
    }
  });

  assert.equal(result, null);
});

test('maybePassThroughFetchLoanApplicationData forwards unmatched live request directly to LSP', async () => {
  const orchestrator = Object.create(ReplayOrchestrator.prototype);
  orchestrator.config = { merchantId: 'flipkart', asyncReplayMode: true };
  orchestrator.validator = {
    currentIndex: 25,
    entries: [
      {
        index: 25,
        isRequest: true,
        source: 'APP',
        destination: 'CORE',
        logTag: 'LSP-GetAgreementDataStatus_REQUEST'
      }
    ],
    processedIndices: new Set(),
    getCurrentEntry() {
      return {
        source: 'APP',
        destination: 'CORE',
        logTag: 'LSP-GetAgreementDataStatus_REQUEST',
        toString() {
          return '[25] LSP-GetAgreementDataStatus_REQUEST APP→CORE';
        }
      };
    }
  };
  orchestrator.getServiceBaseUrl = service => {
    assert.equal(service, 'LSP');
    return 'http://lsp';
  };
  orchestrator.getServiceUnixSocket = () => null;
  let observedRequest = null;
  orchestrator.forwardLiveFetchLoanApplicationDataRequest = async (incoming, merchantId) => {
    observedRequest = { incoming, merchantId };
    return {
      status: 200,
      statusText: 'OK',
      data: { ok: true, source: 'live-lsp' },
      headers: { 'content-type': 'application/json' }
    };
  };

  const result = await orchestrator.maybePassThroughFetchLoanApplicationData({
    source: 'GATEWAY',
    destination: 'LSP',
    api: '/api/fetch/loanApplicationData',
    logTag: 'FECTH_LOAN_APPLICATION_DATA_API_REQUEST',
    requestId: 'live-fetch-loan-request',
    payload: {
      loanApplicationId: 'LA-1',
      requestId: 'live-fetch-loan-request',
      requiredData: ['CUSTOMER_AND_LOAN_DATA'],
      lineId: null
    },
    headers: {
      'x-merchant-id': 'flipkart'
    }
  });

  assert.deepEqual(result, {
    success: true,
    payload: { ok: true, source: 'live-lsp' },
    headers: { 'content-type': 'application/json' },
    status: 200,
    statusText: 'OK',
    error: null,
    livePassThrough: true
  });
  assert.deepEqual(observedRequest, {
    incoming: {
      source: 'GATEWAY',
      destination: 'LSP',
      api: '/api/fetch/loanApplicationData',
      logTag: 'FECTH_LOAN_APPLICATION_DATA_API_REQUEST',
      requestId: 'live-fetch-loan-request',
      payload: {
        loanApplicationId: 'LA-1',
        requestId: 'live-fetch-loan-request',
        requiredData: ['CUSTOMER_AND_LOAN_DATA'],
        lineId: null
      },
      headers: {
        'x-merchant-id': 'flipkart'
      }
    },
    merchantId: 'flipkart'
  });
});

test('maybePassThroughFetchLoanApplicationData returns cached response when replay entry was already self-triggered and processed', async () => {
  const orchestrator = Object.create(ReplayOrchestrator.prototype);
  const processedRequestEntry = {
    index: 63,
    isRequest: true,
    source: 'GATEWAY',
    destination: 'LSP',
    logTag: 'FECTH_LOAN_APPLICATION_DATA_API_REQUEST',
    requestId: 'late-live-request',
    payload: {
      requiredData: ['SELECTED_OFFER_SERIALIZER']
    },
    toString() {
      return '[63] FECTH_LOAN_APPLICATION_DATA_API_REQUEST GATEWAY→LSP';
    }
  };
  const responseEntry = {
    logTag: 'FECTH_LOAN_APPLICATION_DATA_API_RESPONSE',
    payload: {
      status: 'SUCCESS',
      selectedOfferSerializer: {
        id: 'offer-1'
      }
    },
    toString() {
      return '[64] FECTH_LOAN_APPLICATION_DATA_API_RESPONSE LSP→GATEWAY';
    }
  };

  orchestrator.validator = {
    entries: [processedRequestEntry],
    processedIndices: new Set([63]),
    getCurrentEntry() {
      return {
        source: 'GATEWAY',
        destination: 'LENDER',
        logTag: 'PRE_DISBURSAL_CHECK_REQUEST',
        toString() {
          return '[65] PRE_DISBURSAL_CHECK_REQUEST GATEWAY→LENDER';
        }
      };
    }
  };
  orchestrator.findCorrespondingResponse = () => responseEntry;

  const result = await orchestrator.maybePassThroughFetchLoanApplicationData({
    source: 'GATEWAY',
    destination: 'LSP',
    api: '/api/fetch/loanApplicationData',
    logTag: 'FECTH_LOAN_APPLICATION_DATA_API_REQUEST',
    requestId: 'late-live-request',
    payload: {
      loanApplicationId: 'LA-1',
      requestId: 'late-live-request',
      requiredData: ['SELECTED_OFFER_SERIALIZER'],
      lineId: null
    }
  });

  assert.deepEqual(result, {
    success: true,
    payload: {
      status: 'SUCCESS',
      selectedOfferSerializer: {
        id: 'offer-1'
      }
    },
    cached: true
  });
});

test('maybePassThroughFetchLoanApplicationData does not reuse cached response for a different live requestId', async () => {
  const orchestrator = Object.create(ReplayOrchestrator.prototype);
  orchestrator.config = { merchantId: 'flipkart', asyncReplayMode: true };
  const processedRequestEntry = {
    index: 63,
    isRequest: true,
    source: 'GATEWAY',
    destination: 'LSP',
    logTag: 'FECTH_LOAN_APPLICATION_DATA_API_REQUEST',
    requestId: 'earlier-live-request',
    payload: {
      requiredData: ['SELECTED_OFFER_SERIALIZER', 'CHECKOUT_DATA', 'LINE_DATA']
    },
    toString() {
      return '[63] FECTH_LOAN_APPLICATION_DATA_API_REQUEST GATEWAY→LSP';
    }
  };

  orchestrator.validator = {
    currentIndex: 25,
    entries: [processedRequestEntry],
    processedIndices: new Set([63]),
    getCurrentEntry() {
      return {
        source: 'APP',
        destination: 'CORE',
        logTag: 'LSP-GetAgreementDataStatus_REQUEST',
        toString() {
          return '[25] LSP-GetAgreementDataStatus_REQUEST APP→CORE';
        }
      };
    }
  };
  orchestrator.findCorrespondingResponse = () => ({
    logTag: 'FECTH_LOAN_APPLICATION_DATA_API_RESPONSE',
    payload: { status: 'SUCCESS' },
    toString() {
      return '[64] FECTH_LOAN_APPLICATION_DATA_API_RESPONSE LSP→GATEWAY';
    }
  });
  orchestrator.forwardLiveFetchLoanApplicationDataRequest = async () => ({
    status: 200,
    statusText: 'OK',
    data: { status: 'SUCCESS', fresh: true },
    headers: {}
  });

  const result = await orchestrator.maybePassThroughFetchLoanApplicationData({
    source: 'GATEWAY',
    destination: 'LSP',
    api: '/api/fetch/loanApplicationData',
    logTag: 'FECTH_LOAN_APPLICATION_DATA_API_REQUEST',
    requestId: 'LSPd6a1cb52e5be45a8b80e45806f08d3b3',
    payload: {
      loanApplicationId: 'LA-OD438103781752992100-flipkart-DMI',
      requestId: 'LSPd6a1cb52e5be45a8b80e45806f08d3b3',
      requiredData: ['SELECTED_OFFER_SERIALIZER', 'CHECKOUT_DATA', 'LINE_DATA'],
      lineId: null
    },
    headers: {
      'x-merchant-id': 'flipkart'
    }
  });

  assert.deepEqual(result, {
    success: true,
    payload: { status: 'SUCCESS', fresh: true },
    headers: {},
    status: 200,
    statusText: 'OK',
    error: null,
    livePassThrough: true
  });
});

test('RetryHandler does not short-circuit fetchLoanApplicationData as a generic retry', () => {
  const validator = {
    getCurrentEntry() {
      return {
        isRequest: true,
        toString() {
          return '[25] LSP-GetAgreementDataStatus_REQUEST APP→CORE';
        }
      };
    },
    matchesExpected() {
      return false;
    },
    entries: [],
    processedIndices: new Set()
  };

  const retryHandler = new RetryHandler({
    validator,
    stateManager: null,
    pendingExternalRequests: new Map(),
    logger: {
      info() {},
      debug() {}
    }
  });

  const result = retryHandler.handleRetryRequest({
    source: 'GATEWAY',
    destination: 'LSP',
    api: '/api/fetch/loanApplicationData',
    logTag: 'FECTH_LOAN_APPLICATION_DATA_API_REQUEST',
    requestId: 'live-fetch-loan-request'
  });

  assert.equal(result, null);
});
