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

test('seedProdAgreementIdsFromLogs and rewriteOutgoingLoanApplicationIds remap stale prod agreementId to live replay agreementId', () => {
  const stateManager = new StateManager();
  stateManager.seedProdAgreementIdsFromLogs([
    {
      payload: {
        agreementId: 'prod-agreement-1',
        nested: {
          agreement_id: 'prod-agreement-2'
        }
      }
    }
  ]);
  stateManager.setCurrentReplayAgreementId('live-agreement-1', { logTag: 'GetAgreementDataRequest-LSP_RESPONSE' });

  const rewritten = stateManager.rewriteOutgoingLoanApplicationIds({
    payload: {
      agreementId: 'prod-agreement-1',
      nested: {
        agreement_id: 'prod-agreement-2'
      }
    }
  });

  assert.equal(rewritten.payload.agreementId, 'live-agreement-1');
  assert.equal(rewritten.payload.nested.agreement_id, 'live-agreement-1');
});

test('seedProdOfferIdsFromLogs and rewriteOutgoingLoanApplicationIds remap stale prod offerId to live replay offerId including plan.id', () => {
  const stateManager = new StateManager();
  stateManager.seedProdOfferIdsFromLogs([
    {
      logTag: 'LSP-SelectOffer_REQUEST',
      payload: {
        offerSerializer: {
          id: 'prod-offer-1'
        }
      }
    }
  ]);
  stateManager.setCurrentReplayOfferId('live-offer-1', { logTag: 'LSP-SelectOffer_REQUEST' });

  const rewritten = stateManager.rewriteOutgoingLoanApplicationIds(
    {
      payload: {
        offer_id: 'prod-offer-1',
        offerSerializer: {
          id: 'prod-offer-1'
        },
        plan: {
          id: 'prod-offer-1'
        }
      }
    },
    { logTag: 'SetRepaymentPlanRequest_REQUEST' }
  );

  assert.equal(rewritten.payload.offer_id, 'live-offer-1');
  assert.equal(rewritten.payload.offerSerializer.id, 'live-offer-1');
  assert.equal(rewritten.payload.plan.id, 'live-offer-1');
});

test('registerMappingsFromPayloadPair does not corrupt loanApplicationId from E-MANDATE applicationid line-scoped field', () => {
  const stateManager = new StateManager();

  const registered = stateManager.registerMappingsFromPayloadPair(
    {
      loanApplicationId: 'LA-prod-1',
      payload: {
        applicationid: 'prod-line-1',
        type: 'emandate'
      }
    },
    {
      payload: {
        applicationid: 'live-line-1',
        type: 'emandate'
      }
    },
    { logTag: 'E-MANDATE SERVICE API_REQUEST' }
  );

  assert.equal(registered, 1);
  assert.equal(stateManager.getMappedIdentifier('lineDetailId', 'prod-line-1'), 'live-line-1');
  assert.equal(stateManager.getMappedIdentifier('loanApplicationId', 'LA-prod-1'), 'LA-prod-1');
});

test('seedProdRequestIdsFromLogs assigns first-seen owner logTag and rewrites only when that logTag has a replay requestId', () => {
  const stateManager = new StateManager();
  stateManager.seedProdRequestIdsFromLogs([
    {
      logTag: 'LSP-LoanStatus_REQUEST',
      payload: {
        requestId: 'prod-req-1'
      }
    },
    {
      logTag: 'FETCH_OFFER_REQUEST',
      payload: {
        request_id: 'prod-req-2'
      }
    },
    {
      logTag: 'OTHER_LOG_TAG',
      payload: {
        nested: {
          requestId: 'prod-req-1'
        }
      }
    }
  ]);

  stateManager.setReplayRequestIdForLogTag('LSP-LoanStatus_REQUEST', 'live-req-1');

  const rewritten = stateManager.rewriteOutgoingLoanApplicationIds({
    headers: {
      'x-request-id': 'prod-req-1'
    },
    payload: {
      requestId: 'prod-req-1',
      nested: {
        request_id: 'prod-req-2'
      }
    }
  });

  assert.equal(stateManager.getRequestIdOwnerLogTag('prod-req-1'), 'LSP-LoanStatus_REQUEST');
  assert.equal(stateManager.getRequestIdOwnerLogTag('prod-req-2'), 'FETCH_OFFER_REQUEST');
  assert.equal(rewritten.headers['x-request-id'], 'live-req-1');
  assert.equal(rewritten.payload.requestId, 'live-req-1');
  assert.equal(rewritten.payload.nested.request_id, 'prod-req-2');
});

test('setReplayRequestIdForLogTag overwrites prior replay requestId for the same owner logTag', () => {
  const stateManager = new StateManager();
  stateManager.seedProdRequestIdsFromLogs([
    {
      logTag: 'LSP-LoanStatus_REQUEST',
      payload: {
        requestId: 'prod-req-1'
      }
    }
  ]);

  stateManager.setReplayRequestIdForLogTag('LSP-LoanStatus_REQUEST', 'live-req-1');
  stateManager.setReplayRequestIdForLogTag('LSP-LoanStatus_REQUEST', 'live-req-2');

  const rewritten = stateManager.rewriteOutgoingLoanApplicationIds({
    payload: {
      requestId: 'prod-req-1'
    }
  });

  assert.equal(rewritten.payload.requestId, 'live-req-2');
});

test('setReplayRequestIdForLogTag makes outbound trigger request id available for later GetAgreementData status reuse', () => {
  const stateManager = new StateManager();

  stateManager.setReplayRequestIdForLogTag(
    'GetAgreementDataRequest_REQUEST',
    'LSP6746d08e5b044fe5b38d4ace9c9c52f6',
    { sourceDestination: 'APP_CORE', source: 'APP', destination: 'CORE' }
  );

  assert.equal(
    stateManager.getReplayRequestIdForLogTag('GetAgreementDataRequest_REQUEST'),
    'LSP6746d08e5b044fe5b38d4ace9c9c52f6'
  );
});

test('clearReplayTransientState preserves replay request ids during rewind cleanup when requested', () => {
  const stateManager = new StateManager();

  stateManager.setReplayRequestIdForLogTag(
    'GetAgreementDataRequest_REQUEST',
    'LSP6746d08e5b044fe5b38d4ace9c9c52f6',
    { sourceDestination: 'APP_CORE', source: 'APP', destination: 'CORE' }
  );

  stateManager.clearReplayTransientState({ preserveReplayRequestIds: true });

  assert.equal(
    stateManager.getReplayRequestIdForLogTag('GetAgreementDataRequest_REQUEST'),
    'LSP6746d08e5b044fe5b38d4ace9c9c52f6'
  );
});

test('clearReplayTransientState preserves all replay mappings during rewind cleanup when request ids are preserved', () => {
  const stateManager = new StateManager();

  stateManager.seedProdLoanApplicationIdsFromLogs([
    {
      payload: {
        loanApplicationId: 'prod-la-1'
      }
    }
  ]);
  stateManager.seedProdAgreementIdsFromLogs([
    {
      payload: {
        agreementId: 'prod-agreement-1'
      }
    }
  ]);
  stateManager.seedProdOfferIdsFromLogs([
    {
      logTag: 'LSP-SelectOffer_REQUEST',
      payload: {
        offerSerializer: {
          id: 'prod-offer-1'
        }
      }
    }
  ]);
  stateManager.seedProdSessionTokensFromLogs([
    {
      payload: {
        sessionToken: 'prod-session-1'
      }
    }
  ]);
  stateManager.seedProdTxnRefIdsFromLogs([
    {
      payload: {
        txnRefId: 'prod-txn-1'
      }
    }
  ]);
  stateManager.seedProdCustomerIdsFromLogs([
    {
      payload: {
        customerId: 'prod-customer-1'
      }
    }
  ]);

  stateManager.setCurrentReplayLoanApplicationId('live-la-1', { logTag: 'LSP-Eligibility_REQUEST' });
  stateManager.setCurrentReplayAgreementId('live-agreement-1', { logTag: 'GetAgreementDataRequest-LSP_RESPONSE' });
  stateManager.setCurrentReplayOfferId(
    'live-offer-1',
    { sourceDestination: 'CORE_GATEWAY', source: 'CORE', destination: 'GATEWAY' }
  );
  stateManager.setCurrentReplaySessionToken('live-session-1', { logTag: 'GetLenderFlows_RESPONSE' });
  stateManager.setCurrentReplayTxnRefId('live-txn-1', { logTag: 'DMI_CREATE_TXN_REQUEST' });
  stateManager.setCurrentReplayCustomerId('live-customer-1', { logTag: 'LSP-Eligibility_REQUEST' });
  stateManager.replayAppAuthByLoanApplicationId.set('live-la-1', {
    sessionToken: 'live-session-1',
    userId: 'live-user-1',
    deviceTokenId: 'live-device-1',
    updatedAt: Date.now(),
    logTag: 'GetLenderFlows_RESPONSE'
  });
  stateManager.forwardedForByContext.set('loanApplicationId:live-la-1', '10.0.0.1');

  stateManager.clearReplayTransientState({ preserveReplayRequestIds: true });

  assert.equal(stateManager.getCurrentReplayLoanApplicationId(), 'live-la-1');
  assert.equal(stateManager.getCurrentReplayAgreementId(), 'live-agreement-1');
  assert.equal(stateManager.getCurrentReplayOfferId(), 'live-offer-1');
  assert.equal(stateManager.getCurrentReplaySessionToken(), 'live-session-1');
  assert.equal(stateManager.getCurrentReplayTxnRefId(), 'live-txn-1');
  assert.equal(stateManager.getCurrentReplayCustomerId(), 'live-customer-1');
  assert.equal(stateManager.getReplayAppAuth('live-la-1')?.sessionToken, 'live-session-1');
  assert.equal(stateManager.forwardedForByContext.get('loanApplicationId:live-la-1'), '10.0.0.1');
  assert.equal(
    stateManager.rewriteOutgoingLoanApplicationIds({ loanApplicationId: 'prod-la-1' }).loanApplicationId,
    'live-la-1'
  );
  assert.equal(
    stateManager.rewriteOutgoingLoanApplicationIds({ agreementId: 'prod-agreement-1' }).agreementId,
    'live-agreement-1'
  );
  assert.equal(
    stateManager.rewriteOutgoingLoanApplicationIds(
      { plan: { id: 'prod-offer-1' } },
      { logTag: 'SetRepaymentPlanRequest_REQUEST' }
    ).plan.id,
    'live-offer-1'
  );
  assert.equal(
    stateManager.rewriteOutgoingLoanApplicationIds({ sessionToken: 'prod-session-1' }).sessionToken,
    'live-session-1'
  );
  assert.equal(
    stateManager.rewriteOutgoingLoanApplicationIds({ txnRefId: 'prod-txn-1' }).txnRefId,
    'live-txn-1'
  );
  assert.equal(
    stateManager.rewriteOutgoingLoanApplicationIds({ customerId: 'prod-customer-1' }).customerId,
    'live-customer-1'
  );
});

test('remapReplayValue rewrites replay response request ids including client_request_id aliases', () => {
  const stateManager = new StateManager();
  stateManager.seedProdRequestIdsFromLogs([
    {
      logTag: 'GetAgreementDataRequest_REQUEST',
      payload: {
        requestId: 'prod-trigger-request-id'
      }
    },
    {
      logTag: 'GetAgreementDataRequest-LSP_RESPONSE',
      payload: {
        requestId: 'prod-callback-request-id'
      }
    }
  ]);

  stateManager.setReplayRequestIdForLogTag('GetAgreementDataRequest_REQUEST', 'live-trigger-request-id');
  stateManager.setReplayRequestIdForLogTag('GetAgreementDataRequest-LSP_RESPONSE', 'live-callback-request-id');

  const remapped = stateManager.remapReplayValue(
    {
      client_request_id: 'prod-trigger-request-id',
      trace_response: {
        requestId: 'prod-callback-request-id'
      }
    },
    null,
    { logTag: 'GetAgreementDataRequest-LSP_RESPONSE' }
  );

  assert.equal(remapped.client_request_id, 'live-trigger-request-id');
  assert.equal(remapped.trace_response.requestId, 'live-callback-request-id');
});

test('handleIncomingResponse remaps pending replay response payload using expected logTag context', async () => {
  const stateManager = new StateManager();
  stateManager.seedProdRequestIdsFromLogs([
    {
      logTag: 'GetAgreementDataRequest-LSP_RESPONSE',
      payload: {
        requestId: 'prod-callback-request-id'
      }
    }
  ]);
  stateManager.setReplayRequestIdForLogTag(
    'GetAgreementDataRequest-LSP_RESPONSE',
    'live-callback-request-id'
  );

  const responsePromise = stateManager.registerPendingRequest('corr-1', {
    message: { log_tag: 'GetAgreementDataRequest-LSP_RESPONSE' },
    logTag: 'GetAgreementDataRequest-LSP_RESPONSE'
  });

  const handled = stateManager.handleIncomingResponse('corr-1', {
    trace_response: {
      requestId: 'prod-callback-request-id'
    }
  });

  const resolved = await responsePromise;

  assert.equal(handled, true);
  assert.equal(resolved.trace_response.requestId, 'live-callback-request-id');
});

test('registerPendingRequest remaps early buffered replay response payload using expected logTag context', async () => {
  const stateManager = new StateManager();
  stateManager.seedProdRequestIdsFromLogs([
    {
      logTag: 'GetAgreementDataRequest-LSP_RESPONSE',
      payload: {
        requestId: 'prod-callback-request-id'
      }
    }
  ]);
  stateManager.setReplayRequestIdForLogTag(
    'GetAgreementDataRequest-LSP_RESPONSE',
    'live-callback-request-id'
  );

  stateManager.pendingResponses.set('corr-2', {
    trace_response: {
      requestId: 'prod-callback-request-id'
    }
  });

  const resolved = await stateManager.registerPendingRequest('corr-2', {
    message: { log_tag: 'GetAgreementDataRequest-LSP_RESPONSE' },
    logTag: 'GetAgreementDataRequest-LSP_RESPONSE'
  });

  assert.equal(resolved.trace_response.requestId, 'live-callback-request-id');
});
