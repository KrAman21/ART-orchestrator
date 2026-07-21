import test from 'node:test';
import assert from 'node:assert/strict';

import { ReplayOrchestrator } from './orchestrator.js';

test('comparePayloads prefers raw trace payload from entry for masked-value comparisons', () => {
  const rawLogs = [
    {
      messageNumber: 1,
      message: {
        log_tag: 'Themis-Eligibility_REQUEST',
        trace_route: 'GATEWAY_THEMIS',
        label: 'GATEWAY',
        trace_request: {
          borrower: {
            businessDetails: {
              monthlyIncome: 'MASKED'
            }
          }
        }
      }
    }
  ];

  const orchestrator = new ReplayOrchestrator(rawLogs);
  const entry = orchestrator.validator.entries[0];

  const comparison = orchestrator.comparePayloads(
    {
      borrower: {
        businessDetails: {
          monthlyIncome: null
        }
      }
    },
    {
      borrower: {
        businessDetails: {
          monthlyIncome: '50000'
        }
      }
    },
    'Themis-Eligibility_REQUEST',
    entry
  );

  assert.equal(comparison.match, true);
  assert.deepEqual(comparison.differenceList, []);
});
