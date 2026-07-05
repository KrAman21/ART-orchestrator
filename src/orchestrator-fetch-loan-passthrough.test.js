import test from 'node:test';
import assert from 'node:assert/strict';

import { ReplayOrchestrator } from './orchestrator.js';

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

test('maybePassThroughFetchLoanApplicationData returns cached response when replay entry was already self-triggered and processed', async () => {
  const orchestrator = Object.create(ReplayOrchestrator.prototype);
  const processedRequestEntry = {
    index: 63,
    isRequest: true,
    source: 'GATEWAY',
    destination: 'LSP',
    logTag: 'FECTH_LOAN_APPLICATION_DATA_API_REQUEST',
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
