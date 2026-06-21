import test from 'node:test';
import assert from 'node:assert/strict';

import { remapReplayIds } from './log-processor.js';

test('remapReplayIds preserves replay lenderId for GetLenderFlows requests', () => {
  const payload = {
    lenderId: 'LSPb8b2b57fe858454d89519d67f51451f1',
    lender_org_id: 'DMI'
  };

  const remapped = remapReplayIds(payload, null, 'GetLenderFlows_REQUEST');

  assert.equal(remapped.lenderId, 'LSPb8b2b57fe858454d89519d67f51451f1');
  assert.equal(remapped.lender_org_id, 'DMI');
});

test('remapReplayIds still remaps lenderId for other DMI requests', () => {
  const payload = {
    lenderId: 'LSPb8b2b57fe858454d89519d67f51451f1',
    lender_org_id: 'DMI'
  };

  const remapped = remapReplayIds(payload, null, 'SomeOther_REQUEST');

  assert.equal(remapped.lenderId, 'LSP134d7524174646adae514b0c0a9659cf');
  assert.equal(remapped.lender_org_id, 'DMI');
});
