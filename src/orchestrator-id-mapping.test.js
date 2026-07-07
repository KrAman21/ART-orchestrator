import test from 'node:test';
import assert from 'node:assert/strict';

import { ReplayOrchestrator } from './orchestrator.js';
import { StateManager } from './services/state-manager.js';

test('registerReplayIdentifierMappings learns live IDs and normalizes future payloads', () => {
  const orchestrator = Object.create(ReplayOrchestrator.prototype);
  orchestrator.stateManager = new StateManager();
  orchestrator.config = {};
  orchestrator.orderId = 'order-1';

  orchestrator.registerReplayIdentifierMappings(
    {
      payload: {
        lineDetail: {
          lineDetailId: 'replay-line',
          merchantUserId: 'replay-mu',
          lineDetailExtensibleData: {
            lineDetailExtensibleDataId: 'replay-lded'
          }
        },
        loanApplication: {
          loanApplicationId: 'replay-la',
          txnRefId: 'replay-txn-ref'
        }
      }
    },
    {
      payload: {
        lineDetail: {
          lineDetailId: 'local-line',
          merchantUserId: 'local-mu',
          lineDetailExtensibleData: {
            lineDetailExtensibleDataId: 'local-lded'
          }
        },
        loanApplication: {
          loanApplicationId: 'local-la',
          txnRefId: 'local-txn-ref'
        }
      }
    }
  );

  const normalized = orchestrator.normalizeIncomingReplayIdentifiers({
    loanApplicationId: 'replay-la',
    payload: {
      applicationid: 'replay-la',
      lineId: 'replay-line',
      loanApplicationId: 'replay-la',
      txnRefId: 'replay-txn-ref',
      merchantUserId: 'replay-mu',
      lineDetailExtensibleDataId: 'replay-lded'
    }
  });

  assert.equal(orchestrator.stateManager.getMappedIdentifier('lineDetailId', 'replay-line'), 'local-line');
  assert.equal(orchestrator.stateManager.getMappedIdentifier('loanApplicationId', 'replay-la'), 'local-la');
  assert.equal(orchestrator.stateManager.getMappedIdentifier('txnRefId', 'replay-txn-ref'), 'local-txn-ref');
  assert.equal(normalized.loanApplicationId, 'local-la');
  assert.equal(normalized.payload.applicationid, 'local-la');
  assert.equal(normalized.payload.lineId, 'local-line');
  assert.equal(normalized.payload.loanApplicationId, 'local-la');
  assert.equal(normalized.payload.txnRefId, 'local-txn-ref');
  assert.equal(normalized.payload.merchantUserId, 'local-mu');
  assert.equal(normalized.payload.lineDetailExtensibleDataId, 'local-lded');
});

test('state manager remaps DMI applicationid to local line detail id when log tag requires it', () => {
  const orchestrator = Object.create(ReplayOrchestrator.prototype);
  orchestrator.stateManager = new StateManager();

  orchestrator.stateManager.registerIdentifierMapping('loanApplicationId', 'replay-la', 'local-la');
  orchestrator.stateManager.registerIdentifierMapping('lineDetailId', 'replay-line', 'local-line');

  const remapped = orchestrator.stateManager.remapReplayValue(
    { applicationid: 'replay-line' },
    null,
    { logTag: 'DMI_WEBHOOK_REQUEST' }
  );

  assert.equal(remapped.applicationid, 'local-line');
});

test('KYC service applicationid does not corrupt later APP_CORE loanApplicationId remap', () => {
  const orchestrator = Object.create(ReplayOrchestrator.prototype);
  orchestrator.stateManager = new StateManager();
  orchestrator.config = {};
  orchestrator.orderId = 'order-1';

  orchestrator.registerReplayIdentifierMappings(
    {
      logTag: 'LSP-LoanStatus_REQUEST',
      message: {
        trace_request: {
          loanApplicationId: 'replay-la',
          loanStatusOrigin: 'SDK'
        }
      }
    },
    {
      logTag: 'LSP-LoanStatus_REQUEST',
      payload: {
        loanApplicationId: 'local-la',
        loanStatusOrigin: 'SDK'
      }
    }
  );

  orchestrator.registerReplayIdentifierMappings(
    {
      logTag: 'KYC SERVICE API_REQUEST',
      payload: {
        redirectionurl: 'https://example.test/KYC/replay-la/DMI/flipkart',
        applicationid: 'replay-line',
        type: 'kyc'
      }
    },
    {
      logTag: 'KYC SERVICE API_REQUEST',
      payload: {
        redirectionurl: 'https://example.test/KYC/local-la/DMI/flipkart',
        applicationid: 'local-line',
        type: 'kyc'
      }
    }
  );

  const normalized = orchestrator.normalizeIncomingReplayIdentifiers({
    logTag: 'LSP-LoanStatus_REQUEST',
    loanApplicationId: 'replay-la',
    payload: {
      loanApplicationId: 'replay-la',
      loanStatusOrigin: 'SDK'
    }
  });

  assert.equal(orchestrator.stateManager.getMappedIdentifier('loanApplicationId', 'replay-la'), 'local-la');
  assert.equal(orchestrator.stateManager.getMappedIdentifier('lineDetailId', 'replay-line'), 'local-line');
  assert.equal(normalized.payload.loanApplicationId, 'local-la');
});

test('HDB submit-additional-data applicationId does not corrupt replay loanApplicationId mapping', () => {
  const orchestrator = Object.create(ReplayOrchestrator.prototype);
  orchestrator.stateManager = new StateManager();
  orchestrator.config = {};
  orchestrator.orderId = 'order-1';

  orchestrator.registerReplayIdentifierMappings(
    {
      logTag: 'LSP-FetchOfferRequest_REQUEST',
      payload: {
        loanApplication: {
          loanApplicationId: 'replay-la'
        }
      }
    },
    {
      logTag: 'LSP-FetchOfferRequest_REQUEST',
      payload: {
        loanApplication: {
          loanApplicationId: 'local-la'
        }
      }
    }
  );

  orchestrator.registerReplayIdentifierMappings(
    {
      logTag: 'HDB_CHECK_OFFERS_API_REQUEST',
      payload: {
        data: {
          applicationId: 'replay-la'
        }
      }
    },
    {
      logTag: 'HDB_CHECK_OFFERS_API_REQUEST',
      payload: {
        data: {
          applicationId: 'HF20251028211676863'
        }
      }
    }
  );

  const normalized = orchestrator.normalizeIncomingReplayIdentifiers({
    logTag: 'WEBHOOK_REQUEST',
    loanApplicationId: 'replay-la',
    payload: {
      loanApplicationId: 'replay-la'
    }
  });

  assert.equal(orchestrator.stateManager.getMappedIdentifier('loanApplicationId', 'replay-la'), 'local-la');
  assert.equal(normalized.payload.loanApplicationId, 'local-la');
});

test('recordObservedIncomingRequest trusts live loan application id only from LSP or GATEWAY traffic', () => {
  const orchestrator = Object.create(ReplayOrchestrator.prototype);
  orchestrator.stateManager = new StateManager();
  orchestrator.observedIncomingRequests = [];

  orchestrator.stateManager.seedProdLoanApplicationIdsFromLogs([
    {
      payload: {
        loanApplicationId: 'prod-la'
      }
    }
  ]);

  orchestrator.recordObservedIncomingRequest({
    source: 'APP',
    destination: 'CORE',
    logTag: 'LSP-LoanStatus_REQUEST',
    payload: {
      loanApplicationId: 'untrusted-live-la'
    }
  });

  assert.equal(orchestrator.stateManager.getCurrentReplayLoanApplicationId(), null);

  orchestrator.recordObservedIncomingRequest({
    source: 'CORE',
    destination: 'GATEWAY',
    logTag: 'Lsp-LoanStatusRequest_REQUEST',
    payload: {
      loanApplicationId: 'trusted-live-la'
    }
  });

  assert.equal(orchestrator.stateManager.getCurrentReplayLoanApplicationId(), 'trusted-live-la');
  assert.equal(
    orchestrator.stateManager.rewriteOutgoingLoanApplicationIds({ loanApplicationId: 'prod-la' }).loanApplicationId,
    'trusted-live-la'
  );
});

test('recordObservedIncomingRequest ignores line detail ids masquerading as trusted loanApplicationId values', () => {
  const orchestrator = Object.create(ReplayOrchestrator.prototype);
  orchestrator.stateManager = new StateManager();
  orchestrator.observedIncomingRequests = [];

  orchestrator.stateManager.seedProdLoanApplicationIdsFromLogs([
    {
      payload: {
        loan_application_id: 'prod-la'
      }
    }
  ]);

  orchestrator.recordObservedIncomingRequest({
    source: 'GATEWAY',
    destination: 'LSP',
    logTag: 'WEBHOOK_REQUEST',
    payload: {
      loanApplicationId: 'live-line-detail-id',
      lineDetail: {
        lineDetailId: 'live-line-detail-id'
      }
    }
  });

  assert.equal(orchestrator.stateManager.getCurrentReplayLoanApplicationId(), null);
});

test('state manager does not learn loanApplicationId mapping from lender line status applicationId field', () => {
  const stateManager = new StateManager();
  stateManager.registerIdentifierMapping('lineDetailId', 'prod-line', 'live-line');

  const registered = stateManager.registerIdentifierMapping(
    'loanApplicationId',
    'prod-la',
    'live-line',
    { logTag: 'LenderLineStatus_RESPONSE' }
  );

  assert.equal(registered, false);
  assert.equal(stateManager.getMappedIdentifier('loanApplicationId', 'prod-la'), 'prod-la');
});

test('registerReplayIdentifierMappings does not let E-MANDATE applicationid overwrite replay loanApplicationId', () => {
  const orchestrator = Object.create(ReplayOrchestrator.prototype);
  orchestrator.stateManager = new StateManager();
  orchestrator.config = {};
  orchestrator.orderId = 'order-1';

  orchestrator.registerReplayIdentifierMappings(
    {
      logTag: 'SetRepaymentPlanStatusRequest_REQUEST',
      loanApplicationId: 'LA-prod-1'
    },
    {
      logTag: 'SetRepaymentPlanStatusRequest_REQUEST',
      payload: {
        loanApplicationId: 'LA-live-1'
      }
    }
  );

  orchestrator.registerReplayIdentifierMappings(
    {
      logTag: 'E-MANDATE SERVICE API_REQUEST',
      loanApplicationId: 'LA-prod-1',
      payload: {
        applicationid: 'prod-line-1',
        type: 'emandate'
      }
    },
    {
      logTag: 'E-MANDATE SERVICE API_REQUEST',
      payload: {
        applicationid: 'live-line-1',
        type: 'emandate'
      }
    }
  );

  assert.equal(orchestrator.stateManager.getMappedIdentifier('loanApplicationId', 'LA-prod-1'), 'LA-live-1');
  assert.equal(orchestrator.stateManager.getMappedIdentifier('lineDetailId', 'prod-line-1'), 'live-line-1');
});

test('recordObservedIncomingRequest trusts live customerId only from LSP or GATEWAY traffic', () => {
  const orchestrator = Object.create(ReplayOrchestrator.prototype);
  orchestrator.stateManager = new StateManager();
  orchestrator.observedIncomingRequests = [];

  orchestrator.stateManager.seedProdCustomerIdsFromLogs([
    {
      payload: {
        customerId: 'prod-customer'
      }
    }
  ]);

  orchestrator.recordObservedIncomingRequest({
    source: 'APP',
    destination: 'CORE',
    logTag: 'LSP-LoanStatus_REQUEST',
    payload: {
      customerId: 'untrusted-live-customer'
    }
  });

  assert.equal(orchestrator.stateManager.getCurrentReplayCustomerId(), null);

  orchestrator.recordObservedIncomingRequest({
    source: 'CORE',
    destination: 'GATEWAY',
    logTag: 'Lsp-LoanStatusRequest_REQUEST',
    payload: {
      customerId: 'trusted-live-customer'
    }
  });

  assert.equal(orchestrator.stateManager.getCurrentReplayCustomerId(), 'trusted-live-customer');
  assert.equal(
    orchestrator.stateManager.rewriteOutgoingLoanApplicationIds({ customerId: 'prod-customer' }).customerId,
    'trusted-live-customer'
  );
});

test('recordObservedIncomingRequest trusts live txnRefId only from GATEWAY_LENDER traffic', () => {
  const orchestrator = Object.create(ReplayOrchestrator.prototype);
  orchestrator.stateManager = new StateManager();
  orchestrator.observedIncomingRequests = [];

  orchestrator.stateManager.seedProdTxnRefIdsFromLogs([
    {
      payload: {
        txnrefid: 'prod-txn-ref'
      }
    }
  ]);

  orchestrator.recordObservedIncomingRequest({
    source: 'CORE',
    destination: 'GATEWAY',
    sourceDestination: 'CORE_GATEWAY',
    logTag: 'DMI_TXN_STATUS_REQUEST',
    payload: {
      txnrefid: 'untrusted-live-txn-ref'
    }
  });

  assert.equal(orchestrator.stateManager.getCurrentReplayTxnRefId(), null);

  orchestrator.recordObservedIncomingRequest({
    source: 'GATEWAY',
    destination: 'LENDER',
    sourceDestination: 'GATEWAY_LENDER',
    logTag: 'DMI_CREATE_TXN_REQUEST',
    payload: {
      txnrefid: 'trusted-live-txn-ref'
    }
  });

  assert.equal(orchestrator.stateManager.getCurrentReplayTxnRefId(), 'trusted-live-txn-ref');
  assert.equal(
    orchestrator.stateManager.rewriteOutgoingLoanApplicationIds({ txnRefId: 'prod-txn-ref' }).txnRefId,
    'trusted-live-txn-ref'
  );
});

test('recordObservedIncomingRequest learns live offerId only from LSP-SelectOffer_REQUEST and rewrites repayment plan id', () => {
  const orchestrator = Object.create(ReplayOrchestrator.prototype);
  orchestrator.stateManager = new StateManager();
  orchestrator.observedIncomingRequests = [];

  orchestrator.stateManager.seedProdOfferIdsFromLogs([
    {
      logTag: 'LSP-SelectOffer_REQUEST',
      payload: {
        offerSerializer: {
          id: 'prod-offer'
        }
      }
    }
  ]);

  orchestrator.recordObservedIncomingRequest({
    source: 'CORE',
    destination: 'GATEWAY',
    logTag: 'SetRepaymentPlanRequest-LSP_REQUEST',
    payload: {
      plan: {
        id: 'untrusted-live-offer'
      }
    }
  });

  assert.equal(orchestrator.stateManager.getCurrentReplayOfferId(), null);

  orchestrator.recordObservedIncomingRequest({
    source: 'CORE',
    destination: 'GATEWAY',
    logTag: 'LSP-SelectOffer_REQUEST',
    payload: {
      offerSerializer: {
        id: 'trusted-live-offer'
      }
    }
  });

  assert.equal(orchestrator.stateManager.getCurrentReplayOfferId(), 'trusted-live-offer');

  const rewritten = orchestrator.stateManager.rewriteOutgoingLoanApplicationIds(
    {
      plan: {
        id: 'prod-offer'
      }
    },
    { logTag: 'SetRepaymentPlanRequest_REQUEST' }
  );

  assert.equal(rewritten.plan.id, 'trusted-live-offer');
});
