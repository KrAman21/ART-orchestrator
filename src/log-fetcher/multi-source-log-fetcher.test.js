import test from 'node:test';
import assert from 'node:assert/strict';

import {
  shouldDiscardLoanApplicationLogSet,
  shouldSkipReplayForMultipleOrderContextLaids
} from './multi-source-log-fetcher.js';

test('shouldSkipReplayForMultipleOrderContextLaids returns true only when order-context API resolved more than one LAID', () => {
  assert.equal(
    shouldSkipReplayForMultipleOrderContextLaids({
      success: true,
      loanApplicationIds: ['LA-1', 'LA-2']
    }),
    true
  );

  assert.equal(
    shouldSkipReplayForMultipleOrderContextLaids({
      success: true,
      loanApplicationIds: ['LA-1']
    }),
    false
  );

  assert.equal(
    shouldSkipReplayForMultipleOrderContextLaids({
      success: false,
      loanApplicationIds: ['LA-1', 'LA-2']
    }),
    false
  );
});

test('shouldDiscardLoanApplicationLogSet discards LA logs when any top-level order_id belongs to another order', () => {
  const decision = shouldDiscardLoanApplicationLogSet(
    'order-1',
    [
      { message: { created_at: '2026-07-05T10:00:00.000Z', order_id: 'order-1' } }
    ],
    [
      { message: { created_at: '2026-07-05T10:01:00.000Z', order_id: 'order-1' } },
      { message: { created_at: '2026-07-05T10:02:00.000Z', order_id: 'order-2' } }
    ]
  );

  assert.deepEqual(decision, {
    discard: true,
    reason: 'mismatched_top_level_order_id',
    topLevelOrderIds: ['order-1', 'order-2']
  });
});

test('shouldDiscardLoanApplicationLogSet keeps LA logs when top-level order_id values are empty or match the replayed order', () => {
  const decision = shouldDiscardLoanApplicationLogSet(
    'order-1',
    [
      { message: { created_at: '2026-07-05T10:00:00.000Z', order_id: 'order-1' } }
    ],
    [
      { message: { created_at: '2026-07-05T10:01:00.000Z', order_id: 'order-1' } },
      { message: { created_at: '2026-07-05T10:02:00.000Z', order_id: null } },
      { message: { created_at: '2026-07-05T10:03:00.000Z' } }
    ]
  );

  assert.deepEqual(decision, {
    discard: false,
    reason: null,
    topLevelOrderIds: ['order-1']
  });
});
