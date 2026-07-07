import test from 'node:test';
import assert from 'node:assert/strict';

import { remapReplayIds } from './log-processor.js';
import { StateManager } from '../services/state-manager.js';

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

test('remapReplayIds normalizes HDB webhook application identifiers to mapped loan application id', () => {
  const stateManager = new StateManager();
  stateManager.registerIdentifierMapping('loanApplicationId', 'replay-la', 'local-la');

  const payload = {
    data: {
      applicationId: 'HF20251028211676863',
      partnerRefNo: 'HF20251028211676863',
      loanApplicationId: '4230d22f-f6b-44fd-a3c2-3eacd758e502'
    }
  };

  const remapped = remapReplayIds(
    payload,
    stateManager,
    'HDB_WEBHOOK_REQUEST',
    null,
    'local-la'
  );

  assert.equal(remapped.data.applicationId, 'local-la');
  assert.equal(remapped.data.partnerRefNo, 'local-la');
  assert.equal(remapped.data.loanApplicationId, '4230d22f-f6b-44fd-a3c2-3eacd758e502');
});
