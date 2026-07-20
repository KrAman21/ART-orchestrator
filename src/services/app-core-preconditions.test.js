import test from 'node:test';
import assert from 'node:assert/strict';

import { StateManager } from './state-manager.js';
import { __testables } from './app-core-preconditions.js';

test('resolveMerchantCustomerId prefers explicit replay customer ids over merchant user id', () => {
  const stateManager = new StateManager();
  stateManager.setCurrentReplayCustomerId('live-customer-1', {
    logTag: 'LSP-FetchOfferSync_REQUEST',
    source: 'CORE',
    destination: 'GATEWAY',
    sourceDestination: 'CORE_GATEWAY'
  });

  const merchantCustomerId = __testables.resolveMerchantCustomerId(
    {
      logTag: 'GetAgreementDataRequest_REQUEST',
      payload: {
        merchantUserId: 'LSP-live-merchant-user'
      }
    },
    stateManager
  );

  assert.equal(merchantCustomerId, 'live-customer-1');
});

test('resolveMerchantCustomerId falls back to checkout metadata before replay state', () => {
  const stateManager = new StateManager();
  stateManager.setCurrentReplayCustomerId('live-customer-1', {
    logTag: 'LSP-FetchOfferSync_REQUEST',
    source: 'CORE',
    destination: 'GATEWAY',
    sourceDestination: 'CORE_GATEWAY'
  });

  const merchantCustomerId = __testables.resolveMerchantCustomerId(
    {
      payload: {
        loanApplication: {
          checkoutData: {
            metadata: {
              merchantCustomerId: 'checkout-customer-1'
            }
          }
        }
      }
    },
    stateManager
  );

  assert.equal(merchantCustomerId, 'checkout-customer-1');
});

test('resolveMerchantCustomerId returns null when no safe customer id exists', () => {
  const merchantCustomerId = __testables.resolveMerchantCustomerId({
    payload: {
      merchantUserId: 'LSP-live-merchant-user'
    }
  });

  assert.equal(merchantCustomerId, null);
});
