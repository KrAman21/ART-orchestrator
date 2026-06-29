import test from 'node:test';
import assert from 'node:assert/strict';

import { shouldSkipReplayForMultipleOrderContextLaids } from './multi-source-log-fetcher.js';

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
