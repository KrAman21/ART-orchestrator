import test from 'node:test';
import assert from 'node:assert/strict';

import { normalizeCanonicalLoanApplicationReferences } from './canonical-loan-application-id.js';

test('normalizeCanonicalLoanApplicationReferences rewrites nested replay reference ids and journey step loanApplicationIds', () => {
  const canonicalLoanApplicationId = 'LA-OD337949319166416100-flipkart-DMI';
  const payload = {
    lineDetail: {
      lineDetailExtensibleData: {
        referenceId: 'LSP85ca49b82b3a4c1e9b1bca37a897d115',
        journeyData: {
          steps: [
            {
              state: 'KYC_COMPLETED',
              loanApplicationId: 'LSP85ca49b82b3a4c1e9b1bca37a897d115'
            },
            {
              state: 'REPAYMENT_SETUP_COMPLETED',
              loan_application_id: 'LSP85ca49b82b3a4c1e9b1bca37a897d115'
            }
          ]
        }
      }
    },
    loanApplication: {
      loanApplicationId: canonicalLoanApplicationId
    }
  };

  const normalized = normalizeCanonicalLoanApplicationReferences(payload, canonicalLoanApplicationId);

  assert.equal(
    normalized.lineDetail.lineDetailExtensibleData.referenceId,
    canonicalLoanApplicationId
  );
  assert.equal(
    normalized.lineDetail.lineDetailExtensibleData.journeyData.steps[0].loanApplicationId,
    canonicalLoanApplicationId
  );
  assert.equal(
    normalized.lineDetail.lineDetailExtensibleData.journeyData.steps[1].loan_application_id,
    canonicalLoanApplicationId
  );
  assert.equal(
    normalized.loanApplication.loanApplicationId,
    canonicalLoanApplicationId
  );
});
