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
