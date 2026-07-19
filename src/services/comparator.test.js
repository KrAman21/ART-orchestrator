import test from 'node:test';
import assert from 'node:assert/strict';

import { compareLog } from './comparator.js';

test('compareLog ignores masked value mismatches, even when the masked field is missing', () => {
  const result = compareLog(
    {
      applicant: {
        userData: {
          addressType: 'XXXXVERY'
        }
      }
    },
    {
      applicant: {
        userData: {}
      }
    },
    'LSP-Eligibility_REQUEST'
  );

  assert.equal(result.match, true);
  assert.deepEqual(result.differenceList, []);
});

test('compareLog ignores timestamp-like, sessionToken, and ip fields', () => {
  const result = compareLog(
    {
      offerSerializer: {
        validTill: '2026-07-01T09:25:47.618216955Z'
      },
      sessionToken: 'expected-token',
      ip: '10.0.0.1'
    },
    {
      offerSerializer: {
        validTill: '2026-07-02T07:28:08.297127Z'
      },
      sessionToken: 'actual-token',
      ip: '10.0.0.2'
    },
    'LSP-SelectOffer_REQUEST'
  );

  assert.equal(result.match, true);
  assert.deepEqual(result.differenceList, []);
});

test('compareLog unwraps actual payload envelope before comparing', () => {
  const result = compareLog(
    {
      loanStatus: null,
      status: 'SUCCESS',
      interestAmount: null,
      numberOfInstallments: null,
      error: null,
      lendersLoanId: null,
      lspLoanId: null,
      amount: null,
      lender: {
        id: 'LSPb8b2b57fe858454d89519d67f51451f1',
        name: 'XXI',
        orgId: 'DMI'
      },
      txnUuid: 'PZT2607171150DI46301',
      statusSource: 'LENDER',
      lastCompletedState: 'REPAYMENT_SETUP_COMPLETED'
    },
    {
      payload: {
        loanStatus: null,
        status: 'SUCCESS',
        interestAmount: null,
        numberOfInstallments: null,
        error: null,
        lendersLoanId: null,
        lspLoanId: null,
        amount: null,
        lender: {
          id: 'LSPb8b2b57fe858454d89519d67f51451f1',
          name: 'XXI',
          orgId: 'DMI'
        },
        txnUuid: 'PZT2607171150DI46301',
        statusSource: 'LENDER',
        lastCompletedState: 'REPAYMENT_SETUP_COMPLETED'
      },
      ack: {
        error: '0'
      }
    },
    'JuspaySDK-FetchStatus_RESPONSE'
  );

  assert.equal(result.match, true);
  assert.deepEqual(result.differenceList, []);
});
