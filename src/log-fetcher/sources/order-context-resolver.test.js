import test from 'node:test';
import assert from 'node:assert/strict';

import { extractReplayContextFromLogs } from './order-context-resolver.js';

test('extractReplayContextFromLogs only uses top-level S3 message loan_application_id values', () => {
  const logs = [
    {
      message: {
        merchant_customer_id: 'customer-1',
        loan_application_id: 'loan-1',
        trace_request: JSON.stringify({
          loan_application_id: 'loan-2',
          nested: {
            loanApplicationIds: ['loan-2', 'loan-3']
          }
        }),
        trace_response: {
          lineDetails: {
            lineDetailExtensibleData: {
              referenceId: 'loan-4',
              journeyData: {
                steps: [
                  { loanApplicationId: 'loan-5' }
                ]
              }
            }
          }
        }
      }
    },
    {
      message: {
        loan_application_id: 'loan-1',
        trace_response: {
          loanApplicationId: 'loan-3',
          customerId: 'customer-2'
        }
      }
    },
    {
      message: {
        trace_request: '{"loan_application_id":'
      }
    }
  ];

  const context = extractReplayContextFromLogs(logs);

  assert.equal(context.customerId, 'customer-1');
  assert.deepEqual(context.loanApplicationIds, ['loan-1']);
});
