import test from 'node:test';
import assert from 'node:assert/strict';

import { normalizeHdbWebhookLoanApplicationIdentifiers, remapReplayIds } from './log-processor.js';
import { StateManager } from '../services/state-manager.js';

test('remapReplayIds preserves lenderId for GetLenderFlows requests so it stays in the config-seeded replay namespace', () => {
  const payload = {
    lenderId: 'LSPb8b2b57fe858454d89519d67f51451f1',
    lender_org_id: 'DMI'
  };

  const remapped = remapReplayIds(payload, null, 'GetLenderFlows_REQUEST');

  assert.equal(remapped.lenderId, 'LSPb8b2b57fe858454d89519d67f51451f1');
  assert.equal(remapped.lender_org_id, 'DMI');
});

test('remapReplayIds preserves lenderId for other requests as well', () => {
  const payload = {
    lenderId: 'LSPb8b2b57fe858454d89519d67f51451f1',
    lender_org_id: 'DMI'
  };

  const remapped = remapReplayIds(payload, null, 'SomeOther_REQUEST');

  assert.equal(remapped.lenderId, 'LSPb8b2b57fe858454d89519d67f51451f1');
  assert.equal(remapped.lender_org_id, 'DMI');
});

test('remapReplayIds normalizes HDB webhook application identifiers to mapped loan application id', () => {
  const stateManager = new StateManager();
  stateManager.registerIdentifierMapping('loanApplicationId', 'replay-la', 'local-la');

  const payload = {
    data: {
      applicationId: 'HF20251028211676863',
      partnerRefNo: 'HF20251028211676863',
      loanApplicationId: 'local-la'
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
  assert.equal(remapped.data.loanApplicationId, 'local-la');
});

test('normalizeHdbWebhookLoanApplicationIdentifiers rewrites KYC_INITIATED stale HF ids to the replay loan application id', () => {
  const normalized = normalizeHdbWebhookLoanApplicationIdentifiers(
    {
      data: {
        loanApplicationId: 'LSP21409f53b4d14efc847a51daa6f5f50b',
        merchantName: 'XXXXKART',
        applicationId: 'HF20251076901450623',
        loan_status: 'KYC_INITIATED',
        reAttempt: true,
        partnerRefNo: 'HF20251076901450623'
      }
    },
    'LSP21409f53b4d14efc847a51daa6f5f50b'
  );

  assert.deepEqual(normalized, {
    data: {
      loanApplicationId: 'LSP21409f53b4d14efc847a51daa6f5f50b',
      merchantName: 'XXXXKART',
      applicationId: 'LSP21409f53b4d14efc847a51daa6f5f50b',
      loan_status: 'KYC_INITIATED',
      reAttempt: true,
      partnerRefNo: 'LSP21409f53b4d14efc847a51daa6f5f50b'
    }
  });
});
