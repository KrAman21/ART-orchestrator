import test from 'node:test';
import assert from 'node:assert/strict';

import { maybeRecoverStalledExternalReplayEntry } from './sequential-runner.js';

test('maybeRecoverStalledExternalReplayEntry force-sends stalled LENDER to GATEWAY request once outer runner detects repeated stall', async () => {
  const entry = {
    index: 36,
    logTag: 'DMI_WEBHOOK_REQUEST',
    source: 'LENDER',
    destination: 'GATEWAY',
    isRequest: true
  };

  let recoveredEntry = null;
  let resolvedEntry = null;

  const orchestrator = {
    validator: {
      processedIndices: new Set()
    },
    triggerExternalRequestAsync: async currentEntry => {
      recoveredEntry = currentEntry;
      return { success: true };
    },
    markStuckEntryResolved: currentEntry => {
      resolvedEntry = currentEntry;
    }
  };

  const runnerRecoveryState = {
    lastRecoveredEntryIndex: null
  };

  const recovered = await maybeRecoverStalledExternalReplayEntry(
    orchestrator,
    entry,
    2500,
    1000,
    'order-1',
    1,
    1,
    runnerRecoveryState
  );

  assert.equal(recovered, true);
  assert.equal(recoveredEntry, entry);
  assert.equal(resolvedEntry, entry);
  assert.equal(runnerRecoveryState.lastRecoveredEntryIndex, 36);
});

test('maybeRecoverStalledExternalReplayEntry does not retry same stuck entry twice from outer runner', async () => {
  const entry = {
    index: 36,
    logTag: 'DMI_WEBHOOK_REQUEST',
    source: 'LENDER',
    destination: 'GATEWAY',
    isRequest: true
  };

  let recoveryCalls = 0;
  const orchestrator = {
    validator: {
      processedIndices: new Set()
    },
    triggerExternalRequestAsync: async () => {
      recoveryCalls += 1;
      return { success: true };
    },
    markStuckEntryResolved: () => {}
  };

  const runnerRecoveryState = {
    lastRecoveredEntryIndex: 36
  };

  const recovered = await maybeRecoverStalledExternalReplayEntry(
    orchestrator,
    entry,
    5000,
    1000,
    'order-1',
    1,
    1,
    runnerRecoveryState
  );

  assert.equal(recovered, false);
  assert.equal(recoveryCalls, 0);
});
