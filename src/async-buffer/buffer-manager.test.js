import test from 'node:test';
import assert from 'node:assert/strict';

import { BufferManager } from './buffer-manager.js';

function createExpectedEntry(overrides = {}) {
  return {
    logTag: 'FETCH_OFFER_REQUEST',
    source: 'GATEWAY',
    destination: 'LSP',
    requestId: 'req-1',
    loanApplicationId: null,
    lenderOrgId: null,
    toString() {
      return `[0] ${this.logTag} ${this.source}->${this.destination}`;
    },
    ...overrides
  };
}

function createIncomingRequest(overrides = {}) {
  return {
    logTag: 'FETCH_OFFER_REQUEST',
    source: 'GATEWAY',
    destination: 'LSP',
    requestId: 'req-1',
    payload: { ok: true },
    ...overrides
  };
}

test('buffers, matches, and delivers a response through the same waiting request', async () => {
  const manager = new BufferManager({
    defaultTimeoutMs: 200,
    cleanupIntervalMs: 25,
    completedRetentionMs: 25
  });

  try {
    const entry = await manager.addIncomingRequest(createIncomingRequest());
    const claimed = await manager.waitForMatchingRequest(createExpectedEntry(), 50);

    assert.equal(claimed?.key, entry.key);
    assert.equal(claimed?.state, 'claimed');

    manager.completeIncomingRequest(entry.key, { success: true, payload: { id: 1 } });

    await assert.doesNotReject(entry.deferred.promise);
    const response = await entry.deferred.promise;
    assert.deepEqual(response, { success: true, payload: { id: 1 } });
  } finally {
    manager.stop();
  }
});

test('waits for a future matching request and claims it when buffered later', async () => {
  const manager = new BufferManager({
    defaultTimeoutMs: 200,
    cleanupIntervalMs: 25
  });

  try {
    const matchPromise = manager.waitForMatchingRequest(createExpectedEntry(), 100);

    setTimeout(() => {
      void manager.addIncomingRequest(createIncomingRequest());
    }, 20);

    const claimed = await matchPromise;
    assert.ok(claimed);
    assert.equal(claimed.state, 'claimed');
    assert.equal(claimed.request.requestId, 'req-1');
    manager.completeIncomingRequest(claimed.key, { success: true });
    await claimed.deferred.promise;
  } finally {
    manager.stop();
  }
});

test('times out when the replay thread never receives a matching request', async () => {
  const manager = new BufferManager({
    defaultTimeoutMs: 200,
    cleanupIntervalMs: 25
  });

  try {
    const claimed = await manager.waitForMatchingRequest(createExpectedEntry(), 30);
    assert.equal(claimed, null);
  } finally {
    manager.stop();
  }
});

test('reuses the existing buffered entry for duplicate requests', async () => {
  const manager = new BufferManager({
    defaultTimeoutMs: 200,
    cleanupIntervalMs: 25
  });

  try {
    const first = await manager.addIncomingRequest(createIncomingRequest());
    const second = await manager.addIncomingRequest(createIncomingRequest());

    assert.equal(second, first);
    assert.equal(manager.incomingRequests.size, 1);
    manager.failIncomingRequest(first.key, new Error('test cleanup'));
    await assert.rejects(first.deferred.promise, /test cleanup/);
  } finally {
    manager.stop();
  }
});

test('keeps distinct CORE->GATEWAY fetchOfferSync calls when outer requestId is shared but payload requestId differs', async () => {
  const manager = new BufferManager({
    defaultTimeoutMs: 200,
    cleanupIntervalMs: 25
  });

  try {
    const staticCall = await manager.addIncomingRequest(createIncomingRequest({
      logTag: 'LSP-FetchOfferSync_REQUEST',
      source: 'CORE',
      destination: 'GATEWAY',
      requestId: 'shared-http-request-id',
      payload: {
        requestId: 'payload-static-request-id',
        offerType: 'STATIC',
        loanApplicationId: 'loan-1'
      }
    }));

    const realtimeCall = await manager.addIncomingRequest(createIncomingRequest({
      logTag: 'LSP-FetchOfferSync_REQUEST',
      source: 'CORE',
      destination: 'GATEWAY',
      requestId: 'shared-http-request-id',
      payload: {
        requestId: 'payload-realtime-request-id',
        offerType: 'REAL_TIME',
        loanApplicationId: 'loan-1'
      }
    }));

    assert.notEqual(staticCall.key, realtimeCall.key);
    assert.equal(manager.incomingRequests.size, 2);

    const firstClaim = await manager.waitForMatchingRequest(createExpectedEntry({
      logTag: 'LSP-FetchOfferSync_REQUEST',
      source: 'CORE',
      destination: 'GATEWAY',
      requestId: 'shared-http-request-id',
      loanApplicationId: 'loan-1',
      payload: {
        requestId: 'expected-static-log-request-id',
        offerType: 'STATIC',
        loanApplicationId: 'loan-1'
      }
    }), 50);

    assert.equal(firstClaim?.request.payload.offerType, 'STATIC');
    assert.equal(firstClaim?.request.payload.requestId, 'payload-static-request-id');

    const secondClaim = await manager.waitForMatchingRequest(createExpectedEntry({
      logTag: 'LSP-FetchOfferSync_REQUEST',
      source: 'CORE',
      destination: 'GATEWAY',
      requestId: 'shared-http-request-id',
      loanApplicationId: 'loan-1',
      payload: {
        requestId: 'expected-realtime-log-request-id',
        offerType: 'REAL_TIME',
        loanApplicationId: 'loan-1'
      }
    }), 50);

    assert.equal(secondClaim?.request.payload.offerType, 'REAL_TIME');
    assert.equal(secondClaim?.request.payload.requestId, 'payload-realtime-request-id');
  } finally {
    manager.stop();
  }
});

test('distinguishes repeated CORE->GATEWAY fetchOfferSync calls by plansFilteringType and claims the correct sibling', async () => {
  const manager = new BufferManager({
    defaultTimeoutMs: 200,
    cleanupIntervalMs: 25
  });

  try {
    const ncemiCall = await manager.addIncomingRequest(createIncomingRequest({
      logTag: 'LSP-FetchOfferSync_REQUEST',
      source: 'CORE',
      destination: 'GATEWAY',
      requestId: 'shared-http-request-id',
      payload: {
        requestId: 'payload-ncemi-request-id',
        offerType: 'REAL_TIME',
        plansFilteringType: 'TENURE_AND_ROI_NCEMI',
        loanApplicationId: 'loan-1'
      }
    }));

    const regularCall = await manager.addIncomingRequest(createIncomingRequest({
      logTag: 'LSP-FetchOfferSync_REQUEST',
      source: 'CORE',
      destination: 'GATEWAY',
      requestId: 'shared-http-request-id',
      payload: {
        requestId: 'payload-regular-request-id',
        offerType: 'REAL_TIME',
        plansFilteringType: 'TENURE_AND_ROI',
        loanApplicationId: 'loan-1'
      }
    }));

    assert.notEqual(ncemiCall.key, regularCall.key);
    assert.equal(manager.incomingRequests.size, 2);

    const firstClaim = await manager.waitForMatchingRequest(createExpectedEntry({
      logTag: 'LSP-FetchOfferSync_REQUEST',
      source: 'CORE',
      destination: 'GATEWAY',
      requestId: 'shared-http-request-id',
      loanApplicationId: 'loan-1',
      payload: {
        requestId: 'expected-ncemi-log-request-id',
        offerType: 'REAL_TIME',
        plansFilteringType: 'TENURE_AND_ROI_NCEMI',
        loanApplicationId: 'loan-1'
      }
    }), 50);

    assert.equal(firstClaim?.request.payload.plansFilteringType, 'TENURE_AND_ROI_NCEMI');
    assert.equal(firstClaim?.request.payload.requestId, 'payload-ncemi-request-id');

    const secondClaim = await manager.waitForMatchingRequest(createExpectedEntry({
      logTag: 'LSP-FetchOfferSync_REQUEST',
      source: 'CORE',
      destination: 'GATEWAY',
      requestId: 'shared-http-request-id',
      loanApplicationId: 'loan-1',
      payload: {
        requestId: 'expected-regular-log-request-id',
        offerType: 'REAL_TIME',
        plansFilteringType: 'TENURE_AND_ROI',
        loanApplicationId: 'loan-1'
      }
    }), 50);

    assert.equal(secondClaim?.request.payload.plansFilteringType, 'TENURE_AND_ROI');
    assert.equal(secondClaim?.request.payload.requestId, 'payload-regular-request-id');
  } finally {
    manager.stop();
  }
});

test('does not match LOAN_STATUS_ASYNC_RESPONSE_REQUEST when loanDetails.loanStatus differs', async () => {
  const manager = new BufferManager({
    defaultTimeoutMs: 200,
    cleanupIntervalMs: 25
  });

  try {
    await manager.addIncomingRequest(createIncomingRequest({
      logTag: 'LOAN_STATUS_ASYNC_RESPONSE_REQUEST',
      source: 'GATEWAY',
      destination: 'LSP',
      requestId: 'req-1',
      payload: {
        loanMetadata: {
          isLenderApproved: true
        },
        loanDetails: {
          loanStatus: 'REPAYMENT_SETUP_COMPLETED'
        }
      }
    }));

    const claimed = await manager.waitForMatchingRequest(createExpectedEntry({
      logTag: 'LOAN_STATUS_ASYNC_RESPONSE_REQUEST',
      source: 'GATEWAY',
      destination: 'LSP',
      requestId: 'expected-req-1',
      loanApplicationId: 'loan-1',
      lenderOrgId: 'TVS_CREDIT',
      orderId: 'order-1',
      payload: {
        loanMetadata: {
          isLenderApproved: true
        },
        loanDetails: {
          loanStatus: 'GRANTED'
        }
      }
    }), 30);

    assert.equal(claimed, null);
  } finally {
    manager.stop();
  }
});

test('preserves gateway lender request as rewind fallback and uses it after short rewind wait', async () => {
  const manager = new BufferManager({
    defaultTimeoutMs: 200,
    cleanupIntervalMs: 25
  });

  try {
    const preserved = await manager.addIncomingRequest(createIncomingRequest({
      logTag: 'THEMIS_ELIGIBILITY_REQUEST',
      source: 'GATEWAY',
      destination: 'LENDER',
      requestId: 'gw-lender-old',
      lenderOrgId: 'lender-1'
    }));

    manager.resetForReplay();

    assert.equal(manager.incomingRequests.size, 1);
    const rehydrated = manager.incomingRequests.get(preserved.key);
    assert.ok(rehydrated);
    assert.equal(rehydrated.preservedOnRewind, true);
    assert.equal(rehydrated.state, 'buffered');

    const claimed = await manager.waitForMatchingRequest(createExpectedEntry({
      logTag: 'THEMIS_ELIGIBILITY_REQUEST',
      source: 'GATEWAY',
      destination: 'LENDER',
      requestId: 'gw-lender-log',
      lenderOrgId: 'lender-1'
    }), 30);

    assert.ok(claimed);
    assert.equal(claimed.key, preserved.key);
    assert.equal(claimed.preservedOnRewind, true);
    assert.equal(claimed.request.requestId, 'gw-lender-old');
  } finally {
    manager.stop();
  }
});

test('distinguishes fetch loan application data buffered requests by requiredData and claims the matching variant', async () => {
  const manager = new BufferManager({
    defaultTimeoutMs: 200,
    cleanupIntervalMs: 25
  });

  try {
    const selectedOfferRequest = await manager.addIncomingRequest(createIncomingRequest({
      logTag: 'FECTH_LOAN_APPLICATION_DATA_API_REQUEST',
      source: 'GATEWAY',
      destination: 'LSP',
      requestId: 'fetch-loan-selected-offer',
      payload: {
        loanApplicationId: 'loan-1',
        requiredData: ['SELECTED_OFFER_SERIALIZER']
      }
    }));

    const loanApplicationRequest = await manager.addIncomingRequest(createIncomingRequest({
      logTag: 'FECTH_LOAN_APPLICATION_DATA_API_REQUEST',
      source: 'GATEWAY',
      destination: 'LSP',
      requestId: 'fetch-loan-application',
      payload: {
        loanApplicationId: 'loan-1',
        requiredData: ['LOAN_APPLICATION_DATA']
      }
    }));

    const claimedLoanApplication = await manager.waitForMatchingRequest(createExpectedEntry({
      logTag: 'FECTH_LOAN_APPLICATION_DATA_API_REQUEST',
      source: 'GATEWAY',
      destination: 'LSP',
      requestId: 'prod-fetch-loan-application',
      loanApplicationId: 'loan-1',
      payload: {
        loanApplicationId: 'loan-1',
        requiredData: ['LOAN_APPLICATION_DATA']
      }
    }), 50);

    assert.equal(claimedLoanApplication?.key, loanApplicationRequest.key);
    assert.deepEqual(claimedLoanApplication?.request.payload.requiredData, ['LOAN_APPLICATION_DATA']);

    const claimedSelectedOffer = await manager.waitForMatchingRequest(createExpectedEntry({
      logTag: 'FECTH_LOAN_APPLICATION_DATA_API_REQUEST',
      source: 'GATEWAY',
      destination: 'LSP',
      requestId: 'prod-fetch-selected-offer',
      loanApplicationId: 'loan-1',
      payload: {
        loanApplicationId: 'loan-1',
        requiredData: ['SELECTED_OFFER_SERIALIZER']
      }
    }), 50);

    assert.equal(claimedSelectedOffer?.key, selectedOfferRequest.key);
    assert.deepEqual(claimedSelectedOffer?.request.payload.requiredData, ['SELECTED_OFFER_SERIALIZER']);
  } finally {
    manager.stop();
  }
});

test('completed gateway lender request is retained as rewind-only fallback', async () => {
  const manager = new BufferManager({
    defaultTimeoutMs: 200,
    cleanupIntervalMs: 25
  });

  try {
    const original = await manager.addIncomingRequest(createIncomingRequest({
      logTag: 'FK SCORE API_REQUEST',
      source: 'GATEWAY',
      destination: 'LENDER',
      requestId: 'gw-lender-completed',
      lenderOrgId: 'DMI'
    }));

    manager.completeIncomingRequest(original.key, { success: true, payload: { ok: true } });
    await original.deferred.promise;

    assert.equal(manager.incomingRequests.size, 0);
    assert.equal(manager.replayFallbackIncomingRequests.size, 1);

    manager.resetForReplay();

    const claimed = await manager.waitForMatchingRequest(createExpectedEntry({
      logTag: 'FK SCORE API_REQUEST',
      source: 'GATEWAY',
      destination: 'LENDER',
      requestId: 'gw-lender-log',
      lenderOrgId: 'DMI'
    }), 30);

    assert.ok(claimed);
    assert.equal(claimed.request.requestId, 'gw-lender-completed');
    assert.equal(claimed.preservedOnRewind, true);
  } finally {
    manager.stop();
  }
});

test('preserved gateway lender fallback does not expire during cleanup', async () => {
  const manager = new BufferManager({
    defaultTimeoutMs: 40,
    cleanupIntervalMs: 10,
    preservedReplayFallbackWaitMs: 15
  });

  try {
    const original = await manager.addIncomingRequest(createIncomingRequest({
      logTag: 'FK SCORE API_REQUEST',
      source: 'GATEWAY',
      destination: 'LENDER',
      requestId: 'gw-lender-preserve',
      lenderOrgId: 'DMI'
    }));

    manager.completeIncomingRequest(original.key, { success: true });
    await original.deferred.promise;
    manager.resetForReplay();

    await new Promise(resolve => setTimeout(resolve, 90));

    const preserved = manager.incomingRequests.get(original.key);
    assert.ok(preserved);
    assert.equal(preserved.preservedOnRewind, true);
    assert.equal(preserved.state, 'buffered');
  } finally {
    manager.stop();
  }
});

test('live gateway lender future request does not expire before replay reaches it', async () => {
  const manager = new BufferManager({
    defaultTimeoutMs: 40,
    cleanupIntervalMs: 10
  });

  try {
    const original = await manager.addIncomingRequest(createIncomingRequest({
      logTag: 'DECISION API_REQUEST',
      source: 'GATEWAY',
      destination: 'LENDER',
      requestId: null,
      lenderOrgId: 'DMI',
      payload: {
        body: {
          ReadyForDecision: 'Yes',
          LeadId: '00QOW00000ozdz32AA',
          type: 'decide',
          leadsource: 'Flipkart'
        }
      }
    }));

    await new Promise(resolve => setTimeout(resolve, 90));

    const stillBuffered = manager.incomingRequests.get(original.key);
    assert.ok(stillBuffered);
    assert.equal(stillBuffered.state, 'buffered');

    const claimed = await manager.waitForMatchingRequest(createExpectedEntry({
      logTag: 'DECISION API_REQUEST',
      source: 'GATEWAY',
      destination: 'LENDER',
      requestId: 'gw-lender-log',
      lenderOrgId: 'DMI',
      payload: {
        body: {
          ReadyForDecision: 'Yes',
          LeadId: '00QOW00000ozdz32AA',
          type: 'decide',
          leadsource: 'Flipkart'
        }
      }
    }), 30);

    assert.ok(claimed);
    assert.equal(claimed.key, original.key);
  } finally {
    manager.stop();
  }
});

test('completed non-gateway-lender request is not retained as rewind fallback', async () => {
  const manager = new BufferManager({
    defaultTimeoutMs: 200,
    cleanupIntervalMs: 25
  });

  try {
    const original = await manager.addIncomingRequest(createIncomingRequest({
      logTag: 'FETCH_OFFER_ASYNC_RESPONSE_REQUEST',
      source: 'GATEWAY',
      destination: 'LSP',
      requestId: 'fetch-offer-old',
      loanApplicationId: 'loan-1',
      payload: {
        loanApplicationId: 'loan-1',
        loanApplicationStatus: 'INITIATED',
        offerType: 'REAL_TIME'
      }
    }));

    manager.completeIncomingRequest(original.key, { success: true });
    await original.deferred.promise;
    manager.resetForReplay();

    const claimed = await manager.waitForMatchingRequest(createExpectedEntry({
      logTag: 'FETCH_OFFER_ASYNC_RESPONSE_REQUEST',
      source: 'GATEWAY',
      destination: 'LSP',
      requestId: 'fetch-offer-log',
      loanApplicationId: 'loan-1',
      payload: {
        loanApplicationId: 'loan-1',
        loanApplicationStatus: 'INITIATED',
        offerType: 'REAL_TIME'
      }
    }), 30);

    assert.equal(claimed, null);
  } finally {
    manager.stop();
  }
});

test('repeated same-context fetch-offer async requests prefer the better payload match over older FIFO candidate', async () => {
  const manager = new BufferManager({
    defaultTimeoutMs: 200,
    cleanupIntervalMs: 25
  });

  try {
    const older = await manager.addIncomingRequest(createIncomingRequest({
      logTag: 'FETCH_OFFER_ASYNC_RESPONSE_REQUEST',
      source: 'GATEWAY',
      destination: 'LSP',
      requestId: 'fetch-offer-initiated',
      loanApplicationId: 'loan-1',
      payload: {
        loanApplicationId: 'loan-1',
        loanApplicationStatus: 'INITIATED',
        offerType: 'REAL_TIME',
        response: {
          errorMessage: 'Waiting for lender offers'
        },
        eligibility: {
          requiredSteps: [],
          errorMessages: ['Waiting for lender offers'],
          actionRequired: []
        }
      }
    }));

    await new Promise(resolve => setTimeout(resolve, 5));

    const newer = await manager.addIncomingRequest(createIncomingRequest({
      logTag: 'FETCH_OFFER_ASYNC_RESPONSE_REQUEST',
      source: 'GATEWAY',
      destination: 'LSP',
      requestId: 'fetch-offer-action-required',
      loanApplicationId: 'loan-1',
      payload: {
        loanApplicationId: 'loan-1',
        loanApplicationStatus: 'ACTION_REQUIRED',
        offerType: 'REAL_TIME',
        response: {
          errorMessage: 'ACTION_REQUIRED_FOR_AA'
        },
        eligibility: {
          requiredSteps: ['PARENT_BANK_STATEMENT'],
          errorMessages: ['ACTION_REQUIRED_FOR_AA'],
          actionRequired: [
            {
              action: 'ACCOUNT_AGGREGATOR'
            }
          ]
        }
      }
    }));

    const claimed = await manager.waitForMatchingRequest(createExpectedEntry({
      logTag: 'FETCH_OFFER_ASYNC_RESPONSE_REQUEST',
      source: 'GATEWAY',
      destination: 'LSP',
      requestId: 'fetch-offer-log',
      loanApplicationId: 'loan-1',
      payload: {
        loanApplicationId: 'loan-1',
        loanApplicationStatus: 'ACTION_REQUIRED',
        offerType: 'REAL_TIME',
        response: {
          errorMessage: 'ACTION_REQUIRED_FOR_AA'
        },
        eligibility: {
          requiredSteps: ['PARENT_BANK_STATEMENT'],
          errorMessages: ['ACTION_REQUIRED_FOR_AA'],
          actionRequired: [
            {
              action: 'ACCOUNT_AGGREGATOR'
            }
          ]
        }
      }
    }), 30);

    assert.ok(claimed);
    assert.equal(claimed.key, newer.key);
    assert.notEqual(claimed.key, older.key);
  } finally {
    manager.stop();
  }
});

test('LSP-FetchOfferSync waiter does not claim REAL_TIME request for STATIC expected entry', async () => {
  const manager = new BufferManager({
    defaultTimeoutMs: 200,
    cleanupIntervalMs: 25
  });

  try {
    await manager.addIncomingRequest(createIncomingRequest({
      logTag: 'LSP-FetchOfferSync_REQUEST',
      source: 'CORE',
      destination: 'GATEWAY',
      requestId: 'realtime-fetch-offer-sync',
      payload: {
        offerType: 'REAL_TIME',
        plansFilteringType: 'TENURE_AND_ROI_NCEMI'
      }
    }));

    const claimed = await manager.waitForMatchingRequest(createExpectedEntry({
      logTag: 'LSP-FetchOfferSync_REQUEST',
      source: 'CORE',
      destination: 'GATEWAY',
      requestId: 'static-fetch-offer-sync',
      payload: {
        offerType: 'STATIC',
        plansFilteringType: 'TENURE_AND_ROI_NCEMI'
      }
    }), 30);

    assert.equal(claimed, null);
  } finally {
    manager.stop();
  }
});

test('preserved gateway lender fallback is used after short rewind wait instead of long timeout', async () => {
  const manager = new BufferManager({
    defaultTimeoutMs: 200,
    cleanupIntervalMs: 25,
    preservedReplayFallbackWaitMs: 20
  });

  try {
    const original = await manager.addIncomingRequest(createIncomingRequest({
      logTag: 'FK SCORE API_REQUEST',
      source: 'GATEWAY',
      destination: 'LENDER',
      requestId: 'gw-lender-fast-fallback',
      lenderOrgId: 'DMI'
    }));

    manager.completeIncomingRequest(original.key, { success: true });
    await original.deferred.promise;
    manager.resetForReplay();

    const startedAt = Date.now();
    const claimed = await manager.waitForMatchingRequest(createExpectedEntry({
      logTag: 'FK SCORE API_REQUEST',
      source: 'GATEWAY',
      destination: 'LENDER',
      requestId: 'gw-lender-log',
      lenderOrgId: 'DMI'
    }), 50000);

    assert.ok(claimed);
    assert.equal(claimed.request.requestId, 'gw-lender-fast-fallback');
    assert.ok(Date.now() - startedAt < 200);
  } finally {
    manager.stop();
  }
});

test('fresh gateway lender request is preferred over preserved rewind fallback', async () => {
  const manager = new BufferManager({
    defaultTimeoutMs: 200,
    cleanupIntervalMs: 25
  });

  try {
    await manager.addIncomingRequest(createIncomingRequest({
      logTag: 'THEMIS_ELIGIBILITY_REQUEST',
      source: 'GATEWAY',
      destination: 'LENDER',
      requestId: 'gw-lender-old',
      lenderOrgId: 'lender-1'
    }));

    manager.resetForReplay();

    const waiter = manager.waitForMatchingRequest(createExpectedEntry({
      logTag: 'THEMIS_ELIGIBILITY_REQUEST',
      source: 'GATEWAY',
      destination: 'LENDER',
      requestId: 'gw-lender-log',
      lenderOrgId: 'lender-1'
    }), 100);

    setTimeout(() => {
      void manager.addIncomingRequest(createIncomingRequest({
        logTag: 'THEMIS_ELIGIBILITY_REQUEST',
        source: 'GATEWAY',
        destination: 'LENDER',
        requestId: 'gw-lender-fresh',
        lenderOrgId: 'lender-1'
      }));
    }, 20);

    const claimed = await waiter;
    assert.ok(claimed);
    assert.equal(claimed.request.requestId, 'gw-lender-fresh');
    assert.equal(claimed.preservedOnRewind, false);
    assert.equal(manager.incomingRequests.size, 2);
  } finally {
    manager.stop();
  }
});

test('matches buffered requests even when correlation ids differ', async () => {
  const manager = new BufferManager({
    defaultTimeoutMs: 200,
    cleanupIntervalMs: 25
  });

  try {
    const entry = await manager.addIncomingRequest(createIncomingRequest({
      requestId: 'prod-request-id-1',
      traceId: 'trace-from-service'
    }));

    const claimed = await manager.waitForMatchingRequest(
      createExpectedEntry({
        requestId: 'log-request-id-9',
        traceId: 'trace-from-log'
      }),
      50
    );

    assert.equal(claimed?.key, entry.key);
    assert.equal(claimed?.request.requestId, 'prod-request-id-1');
    assert.equal(claimed?.request.traceId, 'trace-from-service');
  } finally {
    manager.stop();
  }
});

test('prefers payload-compatible callback over older same-route buffered request', async () => {
  const manager = new BufferManager({
    defaultTimeoutMs: 200,
    cleanupIntervalMs: 25
  });

  try {
    const initiated = await manager.addIncomingRequest(createIncomingRequest({
      requestId: 'live-initiated',
      payload: {
        loanApplicationStatus: 'INITIATED',
        loanApplicationId: 'loan-live'
      }
    }));

    const offered = await manager.addIncomingRequest(createIncomingRequest({
      requestId: 'live-offered',
      payload: {
        loanApplicationStatus: 'OFFERED',
        loanApplicationId: 'loan-live'
      }
    }));

    const claimed = await manager.waitForMatchingRequest(
      createExpectedEntry({
        requestId: 'log-offered',
        payload: {
          loanApplicationStatus: 'OFFERED',
          loanApplicationId: 'loan-from-log'
        }
      }),
      50
    );

    assert.equal(claimed?.key, offered.key);
    assert.equal(claimed?.request.requestId, 'live-offered');
    assert.equal(claimed?.request.payload.loanApplicationStatus, 'OFFERED');
    assert.equal(initiated.state, 'buffered');
  } finally {
    manager.stop();
  }
});

test('does not reuse waiter for same route when expected payload branch differs', async () => {
  const manager = new BufferManager({
    defaultTimeoutMs: 200,
    cleanupIntervalMs: 25
  });

  try {
    const initiatedWaiter = manager.waitForMatchingRequest(
      createExpectedEntry({
        requestId: 'log-initiated',
        payload: { loanApplicationStatus: 'INITIATED' }
      }),
      100
    );

    const offeredWaiter = manager.waitForMatchingRequest(
      createExpectedEntry({
        requestId: 'log-offered',
        payload: { loanApplicationStatus: 'OFFERED' }
      }),
      100
    );

    setTimeout(() => {
      void manager.addIncomingRequest(createIncomingRequest({
        requestId: 'live-offered',
        payload: { loanApplicationStatus: 'OFFERED' }
      }));
    }, 20);

    const [initiatedClaimed, offeredClaimed] = await Promise.all([initiatedWaiter, offeredWaiter]);

    assert.equal(initiatedClaimed, null);
    assert.equal(offeredClaimed?.request.requestId, 'live-offered');
    assert.equal(offeredClaimed?.request.payload.loanApplicationStatus, 'OFFERED');
  } finally {
    manager.stop();
  }
});

test('getResponseByMetadata finds response with inverted sourceDestination', () => {
  const manager = new BufferManager({
    defaultTimeoutMs: 200,
    cleanupIntervalMs: 25
  });

  try {
    manager.addResponse('resp-1', { data: { token: 'abc' } }, false, {
      logTag: 'GENERATE_PARTNER_AUTH_TOKEN_REQUEST',
      sourceDestination: 'GATEWAY_LENDER'
    });

    const found = manager.getResponseByMetadata(
      'GENERATE_PARTNER_AUTH_TOKEN_RESPONSE',
      'LENDER_GATEWAY'
    );

    assert.ok(found);
    assert.deepEqual(found.response.data, { token: 'abc' });
    assert.equal(manager.responseBuffer.size, 0);
  } finally {
    manager.stop();
  }
});

test('discardResponsesByMetadata removes only matching error responses', () => {
  const manager = new BufferManager({
    defaultTimeoutMs: 200,
    cleanupIntervalMs: 25
  });

  try {
    manager.addResponse('resp-error-match', { data: { status: 'FAILURE' } }, true, {
      logTag: 'FlipKart-CreateLoan_REQUEST',
      sourceDestination: 'APP_WRAPPER',
      orderId: 'order-1',
      requestId: 'req-1'
    });
    manager.addResponse('resp-success-match', { data: { status: 'SUCCESS' } }, false, {
      logTag: 'FlipKart-CreateLoan_REQUEST',
      sourceDestination: 'APP_WRAPPER',
      orderId: 'order-1',
      requestId: 'req-1'
    });
    manager.addResponse('resp-other-order', { data: { status: 'FAILURE' } }, true, {
      logTag: 'FlipKart-CreateLoan_REQUEST',
      sourceDestination: 'APP_WRAPPER',
      orderId: 'order-2',
      requestId: 'req-2'
    });

    const discarded = manager.discardResponsesByMetadata(
      'FlipKart-CreateLoan_RESPONSE',
      'APP_WRAPPER',
      null,
      null,
      null,
      ['req-1'],
      'order-1',
      { onlyErrors: true }
    );

    assert.deepEqual(discarded.map(entry => entry.requestId), ['resp-error-match']);
    assert.equal(manager.responseBuffer.has('resp-error-match'), false);
    assert.equal(manager.responseBuffer.has('resp-success-match'), true);
    assert.equal(manager.responseBuffer.has('resp-other-order'), true);
  } finally {
    manager.stop();
  }
});

test('resetForReplay preserves gateway lender responses in buffer', () => {
  const manager = new BufferManager({
    defaultTimeoutMs: 200,
    cleanupIntervalMs: 25
  });

  try {
    manager.addResponse('resp-preserved', { data: { token: 'keep' } }, false, {
      logTag: 'GENERATE_PARTNER_AUTH_TOKEN_REQUEST',
      sourceDestination: 'GATEWAY_LENDER'
    });
    manager.addResponse('resp-dropped', { data: { token: 'drop' } }, false, {
      logTag: 'FETCH_STATUS_REQUEST',
      sourceDestination: 'APP_LSP'
    });

    manager.resetForReplay();

    assert.equal(manager.responseBuffer.size, 1);
    const preserved = manager.responseBuffer.get('resp-preserved');
    assert.ok(preserved);
    assert.equal(preserved.preservedOnRewind, true);
    assert.equal(manager.responseBuffer.has('resp-dropped'), false);
  } finally {
    manager.stop();
  }
});

test('consumed gateway lender response is retained as rewind-only fallback', () => {
  const manager = new BufferManager({
    defaultTimeoutMs: 200,
    cleanupIntervalMs: 25
  });

  try {
    manager.addResponse('resp-preserved', { data: { token: 'keep' } }, false, {
      logTag: 'GENERATE_PARTNER_AUTH_TOKEN_REQUEST',
      sourceDestination: 'GATEWAY_LENDER'
    });

    const consumed = manager.getResponseByMetadata(
      'GENERATE_PARTNER_AUTH_TOKEN_RESPONSE',
      'LENDER_GATEWAY'
    );

    assert.ok(consumed);
    assert.equal(manager.responseBuffer.size, 0);
    assert.equal(manager.replayFallbackResponses.size, 1);

    manager.resetForReplay();

    assert.equal(manager.responseBuffer.size, 1);
    assert.ok(manager.responseBuffer.get('resp-preserved'));
  } finally {
    manager.stop();
  }
});

test('getResponseByMetadata prefers exact sourceDestination over inverted', () => {
  const manager = new BufferManager({
    defaultTimeoutMs: 200,
    cleanupIntervalMs: 25
  });

  try {
    manager.addResponse('resp-exact', { data: { exact: true } }, false, {
      logTag: 'FETCH_OFFER_REQUEST',
      sourceDestination: 'LENDER_GATEWAY'
    });
    manager.addResponse('resp-inverted', { data: { inverted: true } }, false, {
      logTag: 'FETCH_OFFER_REQUEST',
      sourceDestination: 'GATEWAY_LENDER'
    });

    const found = manager.getResponseByMetadata(
      'FETCH_OFFER_RESPONSE',
      'LENDER_GATEWAY'
    );

    assert.ok(found);
    assert.deepEqual(found.response.data, { exact: true });
    assert.equal(manager.responseBuffer.size, 1);
  } finally {
    manager.stop();
  }
});

test('getResponseByMetadata disambiguates parallel calls using loanApplicationId', () => {
  const manager = new BufferManager({
    defaultTimeoutMs: 200,
    cleanupIntervalMs: 25
  });

  try {
    manager.addResponse('resp-a', { data: { offer: 'A' } }, false, {
      logTag: 'FETCH_OFFER_REQUEST',
      sourceDestination: 'CORE_GATEWAY',
      loanApplicationId: 'loan-111'
    });
    manager.addResponse('resp-b', { data: { offer: 'B' } }, false, {
      logTag: 'FETCH_OFFER_REQUEST',
      sourceDestination: 'CORE_GATEWAY',
      loanApplicationId: 'loan-222'
    });

    const found = manager.getResponseByMetadata(
      'FETCH_OFFER_RESPONSE',
      'GATEWAY_CORE',
      'loan-222'
    );

    assert.ok(found);
    assert.deepEqual(found.response.data, { offer: 'B' });
    assert.equal(manager.responseBuffer.size, 1);
  } finally {
    manager.stop();
  }
});

test('getResponseByMetadata prefers clientRequestId for APP_WRAPPER style correlations', () => {
  const manager = new BufferManager({
    defaultTimeoutMs: 200,
    cleanupIntervalMs: 25
  });

  try {
    manager.addResponse('resp-request-id-match', { data: { picked: 'wrong' } }, false, {
      logTag: 'FlipKart-HardEligibility_REQUEST',
      sourceDestination: 'APP_WRAPPER',
      clientRequestId: 'different-client-id'
    });

    manager.addResponse('resp-client-id-match', { data: { picked: 'right' } }, false, {
      logTag: 'FlipKart-HardEligibility_REQUEST',
      sourceDestination: 'APP_WRAPPER',
      clientRequestId: 'client-123'
    });

    const found = manager.getResponseByMetadata(
      'FlipKart-HardEligibility_RESPONSE',
      'APP_WRAPPER',
      null,
      null,
      'client-123'
    );

    assert.ok(found);
    assert.deepEqual(found.response.data, { picked: 'right' });
    assert.equal(manager.responseBuffer.size, 1);
  } finally {
    manager.stop();
  }
});

test('getResponseByMetadata does not let requestId override stronger mapped identifiers', () => {
  const manager = new BufferManager({
    defaultTimeoutMs: 200,
    cleanupIntervalMs: 25
  });

  try {
    manager.addResponse('resp-request-id', { data: { picked: 'wrong' } }, false, {
      requestId: 'req-from-log',
      logTag: 'FlipKart-HardEligibility_REQUEST',
      sourceDestination: 'APP_WRAPPER',
      clientRequestId: 'different-client-id',
      loanApplicationId: 'loan-a'
    });

    manager.addResponse('resp-client-id', { data: { picked: 'right' } }, false, {
      requestId: 'different-request-id',
      logTag: 'FlipKart-HardEligibility_REQUEST',
      sourceDestination: 'APP_WRAPPER',
      clientRequestId: 'client-123',
      loanApplicationId: 'loan-a'
    });

    const found = manager.getResponseByMetadata(
      'FlipKart-HardEligibility_RESPONSE',
      'APP_WRAPPER',
      'loan-a',
      null,
      'client-123',
      ['req-from-log']
    );

    assert.ok(found);
    assert.deepEqual(found.response.data, { picked: 'right' });
    assert.equal(manager.responseBuffer.size, 1);
  } finally {
    manager.stop();
  }
});

test('getResponseByMetadata narrows multiple same-tag candidates using exact clientRequestId', () => {
  const manager = new BufferManager({
    defaultTimeoutMs: 200,
    cleanupIntervalMs: 25
  });

  try {
    manager.addResponse('resp-a', { data: { picked: 'A' } }, false, {
      logTag: 'FlipKart-HardEligibility_REQUEST',
      sourceDestination: 'APP_WRAPPER',
      clientRequestId: 'client-a'
    });

    manager.addResponse('resp-b', { data: { picked: 'B' } }, false, {
      logTag: 'FlipKart-HardEligibility_REQUEST',
      sourceDestination: 'APP_WRAPPER',
      clientRequestId: 'client-b'
    });

    const found = manager.getResponseByMetadata(
      'FlipKart-HardEligibility_RESPONSE',
      'APP_WRAPPER',
      null,
      null,
      'client-b'
    );

    assert.ok(found);
    assert.deepEqual(found.response.data, { picked: 'B' });
    assert.equal(manager.responseBuffer.size, 1);
  } finally {
    manager.stop();
  }
});

test('getResponseByMetadata disambiguates parallel calls using lenderOrgId', () => {
  const manager = new BufferManager({
    defaultTimeoutMs: 200,
    cleanupIntervalMs: 25
  });

  try {
    manager.addResponse('resp-x', { data: { lender: 'X' } }, false, {
      logTag: 'THEMIS_ELIGIBILITY_REQUEST',
      sourceDestination: 'GATEWAY_LENDER',
      lenderOrgId: 'lender-org-1'
    });
    manager.addResponse('resp-y', { data: { lender: 'Y' } }, false, {
      logTag: 'THEMIS_ELIGIBILITY_REQUEST',
      sourceDestination: 'GATEWAY_LENDER',
      lenderOrgId: 'lender-org-2'
    });

    const found = manager.getResponseByMetadata(
      'THEMIS_ELIGIBILITY_RESPONSE',
      'LENDER_GATEWAY',
      null,
      'lender-org-2'
    );

    assert.ok(found);
    assert.deepEqual(found.response.data, { lender: 'Y' });
    assert.equal(manager.responseBuffer.size, 1);
  } finally {
    manager.stop();
  }
});

test('getResponseByMetadata falls back to oldest when no correlation ids match', () => {
  const manager = new BufferManager({
    defaultTimeoutMs: 200,
    cleanupIntervalMs: 25
  });

  try {
    manager.addResponse('resp-old', { data: { version: 1 } }, false, {
      logTag: 'FETCH_STATUS_REQUEST',
      sourceDestination: 'APP_LSP'
    });

    const found = manager.getResponseByMetadata(
      'FETCH_STATUS_RESPONSE',
      'LSP_APP',
      'nonexistent-loan'
    );

    assert.ok(found);
    assert.deepEqual(found.response.data, { version: 1 });
  } finally {
    manager.stop();
  }
});

test('getResponseByMetadata can disambiguate using orderId when other ids are absent', () => {
  const manager = new BufferManager({
    defaultTimeoutMs: 200,
    cleanupIntervalMs: 25
  });

  try {
    manager.addResponse('resp-order-a', { data: { picked: 'A' } }, false, {
      logTag: 'FETCH_STATUS_REQUEST',
      sourceDestination: 'APP_LSP',
      orderId: 'order-a'
    });
    manager.addResponse('resp-order-b', { data: { picked: 'B' } }, false, {
      logTag: 'FETCH_STATUS_REQUEST',
      sourceDestination: 'APP_LSP',
      orderId: 'order-b'
    });

    const found = manager.getResponseByMetadata(
      'FETCH_STATUS_RESPONSE',
      'LSP_APP',
      null,
      null,
      null,
      [],
      'order-b'
    );

    assert.ok(found);
    assert.deepEqual(found.response.data, { picked: 'B' });
    assert.equal(manager.responseBuffer.size, 1);
  } finally {
    manager.stop();
  }
});

test('resolves async waiter even when sync path already claimed the entry', async () => {
  const manager = new BufferManager({
    defaultTimeoutMs: 200,
    cleanupIntervalMs: 25
  });

  try {
    const waiterPromise = manager.waitForMatchingRequest(createExpectedEntry(), 100);

    manager.addIncomingRequest(createIncomingRequest());

    const claimed = await waiterPromise;
    assert.ok(claimed);
    assert.equal(claimed.state, 'claimed');
  } finally {
    manager.stop();
  }
});
