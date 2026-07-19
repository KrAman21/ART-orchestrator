import test from 'node:test';
import assert from 'node:assert/strict';

import { LogSequenceValidator } from './log-sequence-validator.js';

function createRawLog({
  logTag,
  traceRoute,
  requestId,
  loanApplicationId = 'loan-1',
  traceRequest = null,
  traceResponse = null,
  label = 'GATEWAY'
}) {
  return {
    messageNumber: 1,
    xRequestId: requestId || null,
    message: {
      log_tag: logTag,
      trace_route: traceRoute,
      request_id: requestId || null,
      loan_application_id: loanApplicationId,
      label,
      trace_request: traceRequest,
      trace_response: traceResponse
    }
  };
}

test('matchesExpected distinguishes repeated fetchOfferSync requests by offerType and plansFilteringType', () => {
  const validator = new LogSequenceValidator([
    createRawLog({
      logTag: 'LSP-FetchOfferSync_REQUEST',
      traceRoute: 'CORE_GATEWAY',
      requestId: 'prod-1',
      traceRequest: {
        offerType: 'STATIC',
        plansFilteringType: 'TENURE_AND_ROI',
        loanApplicationId: 'loan-1'
      }
    }),
    createRawLog({
      logTag: 'LSP-FetchOfferSync_REQUEST',
      traceRoute: 'CORE_GATEWAY',
      requestId: 'prod-2',
      traceRequest: {
        offerType: 'REAL_TIME',
        plansFilteringType: 'TENURE_AND_ROI_NCEMI',
        loanApplicationId: 'loan-1'
      }
    })
  ]);

  const first = validator.entries[0];
  const second = validator.entries[1];

  const realtimeIncoming = {
    source: 'CORE',
    destination: 'GATEWAY',
    logTag: 'LSP-FetchOfferSync_REQUEST',
    requestId: 'live-1',
    loanApplicationId: 'loan-1',
    payload: {
      offerType: 'REAL_TIME',
      plansFilteringType: 'TENURE_AND_ROI_NCEMI',
      loanApplicationId: 'loan-1'
    }
  };

  assert.equal(validator.matchesExpected(first, realtimeIncoming), false);
  assert.equal(validator.matchesExpected(second, realtimeIncoming), true);
});
