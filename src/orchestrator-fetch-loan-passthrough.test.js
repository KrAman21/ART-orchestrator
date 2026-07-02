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
