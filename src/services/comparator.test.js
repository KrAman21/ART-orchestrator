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
