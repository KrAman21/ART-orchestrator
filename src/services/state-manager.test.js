import test from 'node:test';
import assert from 'node:assert/strict';

import { StateManager } from './state-manager.js';

test('updateReplayAppAuthFromResponse stores live app auth from stringified GetLenderFlows response', () => {
  const stateManager = new StateManager();

  const updated = stateManager.updateReplayAppAuthFromResponse(
    'LA-1',
    JSON.stringify({
      payload: {
        sessionToken: 'live-session-token-123',
        userId: 'live-user-1',
        deviceTokenId: 'live-device-1'
      }
    }),
    { logTag: 'GetLenderFlows_RESPONSE' }
  );

  assert.equal(updated, true);
  assert.deepEqual(stateManager.getReplayAppAuth('LA-1'), {
    sessionToken: 'live-session-token-123',
    userId: 'live-user-1',
    deviceTokenId: 'live-device-1',
    updatedAt: stateManager.getReplayAppAuth('LA-1').updatedAt,
    logTag: 'GetLenderFlows_RESPONSE'
  });
});

test('seedProdSessionTokensFromLogs and rewriteOutgoingLoanApplicationIds remap stale prod session token to live replay token', () => {
  const stateManager = new StateManager();
  stateManager.seedProdSessionTokensFromLogs([
    {
      payload: {
        sessionToken: 'prod-session-token-1'
      }
    }
  ]);
  stateManager.setCurrentReplaySessionToken('live-session-token-1', { logTag: 'GetLenderFlows_RESPONSE' });

  const rewritten = stateManager.rewriteOutgoingLoanApplicationIds({
    header: {
      'x-session-token': 'prod-session-token-1'
    },
    payload: {
      sessionToken: 'prod-session-token-1'
    }
  });

  assert.equal(rewritten.header['x-session-token'], 'live-session-token-1');
  assert.equal(rewritten.payload.sessionToken, 'live-session-token-1');
});

test('seedProdTxnRefIdsFromLogs and rewriteOutgoingLoanApplicationIds remap stale prod txnRefId to live replay txnRefId', () => {
  const stateManager = new StateManager();
  stateManager.seedProdTxnRefIdsFromLogs([
    {
      payload: {
        txnrefid: 'prod-txn-ref-1'
      }
    }
  ]);
  stateManager.setCurrentReplayTxnRefId('live-txn-ref-1', { logTag: 'DMI_CREATE_TXN_REQUEST' });

  const rewritten = stateManager.rewriteOutgoingLoanApplicationIds({
    payload: {
      txnRefId: 'prod-txn-ref-1',
      nested: {
        txnrefid: 'prod-txn-ref-1'
      }
    }
  });

  assert.equal(rewritten.payload.txnRefId, 'live-txn-ref-1');
  assert.equal(rewritten.payload.nested.txnrefid, 'live-txn-ref-1');
});

test('seedProdCustomerIdsFromLogs and rewriteOutgoingLoanApplicationIds remap stale prod customerId to live replay customerId', () => {
  const stateManager = new StateManager();
  stateManager.seedProdCustomerIdsFromLogs([
    {
      payload: {
        customerId: 'prod-customer-1',
        merchant_customer_id: 'prod-customer-2'
      }
    }
  ]);
  stateManager.setCurrentReplayCustomerId('live-customer-1', { logTag: 'LSP-Eligibility_REQUEST' });

  const rewritten = stateManager.rewriteOutgoingLoanApplicationIds({
    header: {
      customerId: 'prod-customer-1'
    },
    payload: {
      customerId: 'prod-customer-1',
      nested: {
        merchant_customer_id: 'prod-customer-2'
      }
    }
  });

  assert.equal(rewritten.header.customerId, 'live-customer-1');
  assert.equal(rewritten.payload.customerId, 'live-customer-1');
  assert.equal(rewritten.payload.nested.merchant_customer_id, 'live-customer-1');
});
