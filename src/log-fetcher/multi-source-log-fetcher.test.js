import test from 'node:test';
import assert from 'node:assert/strict';

import {
  MultiSourceLogFetcher,
  shouldDiscardLoanApplicationLogSet,
  shouldSkipReplayForMultipleOrderContextLaids
} from './multi-source-log-fetcher.js';

test('shouldSkipReplayForMultipleOrderContextLaids returns true only when order-context API resolved more than one LAID', () => {
  assert.equal(
    shouldSkipReplayForMultipleOrderContextLaids({
      success: true,
      loanApplicationIds: ['LA-1', 'LA-2']
    }),
    true
  );

  assert.equal(
    shouldSkipReplayForMultipleOrderContextLaids({
      success: true,
      loanApplicationIds: ['LA-1']
    }),
    false
  );

  assert.equal(
    shouldSkipReplayForMultipleOrderContextLaids({
      success: false,
      loanApplicationIds: ['LA-1', 'LA-2']
    }),
    false
  );
});

test('shouldDiscardLoanApplicationLogSet sanitizes LA logs when foreign top-level order_id occurrences stay below threshold', () => {
  const decision = shouldDiscardLoanApplicationLogSet(
    'order-1',
    [
      { message: { created_at: '2026-07-05T10:00:00.000Z', order_id: 'order-1' } }
    ],
    [
      { message: { created_at: '2026-07-05T10:01:00.000Z', order_id: 'order-1' } },
      { message: { created_at: '2026-07-05T10:02:00.000Z', order_id: 'order-2' } }
    ]
  );

  assert.equal(decision.discard, false);
  assert.equal(decision.reason, 'sanitized_mismatched_top_level_order_id');
  assert.deepEqual(decision.topLevelOrderIds, ['order-1', 'order-2']);
  assert.deepEqual(decision.foreignOrderIdCounts, [{ orderId: 'order-2', count: 1 }]);
  assert.deepEqual(
    decision.sanitizedLogs,
    [{ message: { created_at: '2026-07-05T10:01:00.000Z', order_id: 'order-1' } }]
  );
});

test('shouldDiscardLoanApplicationLogSet discards LA logs when foreign top-level order_id occurrences hit threshold', () => {
  const decision = shouldDiscardLoanApplicationLogSet(
    'order-1',
    [
      { message: { created_at: '2026-07-05T10:00:00.000Z', order_id: 'order-1' } }
    ],
    [
      { message: { created_at: '2026-07-05T10:01:00.000Z', order_id: 'order-1' } },
      { message: { created_at: '2026-07-05T10:02:00.000Z', order_id: 'order-2' } },
      { message: { created_at: '2026-07-05T10:03:00.000Z', order_id: 'order-2' } },
      { message: { created_at: '2026-07-05T10:04:00.000Z', order_id: 'order-2' } },
      { message: { created_at: '2026-07-05T10:05:00.000Z', order_id: 'order-2' } },
      { message: { created_at: '2026-07-05T10:06:00.000Z', order_id: 'order-2' } }
    ]
  );

  assert.equal(decision.discard, true);
  assert.equal(decision.reason, 'mismatched_top_level_order_id');
  assert.deepEqual(decision.topLevelOrderIds, ['order-1', 'order-2']);
  assert.deepEqual(decision.foreignOrderIdCounts, [{ orderId: 'order-2', count: 5 }]);
});

test('shouldDiscardLoanApplicationLogSet keeps LA logs when top-level order_id values are empty or match the replayed order', () => {
  const decision = shouldDiscardLoanApplicationLogSet(
    'order-1',
    [
      { message: { created_at: '2026-07-05T10:00:00.000Z', order_id: 'order-1' } }
    ],
    [
      { message: { created_at: '2026-07-05T10:01:00.000Z', order_id: 'order-1' } },
      { message: { created_at: '2026-07-05T10:02:00.000Z', order_id: null } },
      { message: { created_at: '2026-07-05T10:03:00.000Z' } }
    ]
  );

  assert.deepEqual(decision, {
    discard: false,
    reason: null,
    topLevelOrderIds: ['order-1'],
    sanitizedLogs: [
      { message: { created_at: '2026-07-05T10:01:00.000Z', order_id: 'order-1' } },
      { message: { created_at: '2026-07-05T10:02:00.000Z', order_id: null } },
      { message: { created_at: '2026-07-05T10:03:00.000Z' } }
    ],
    foreignOrderIdCounts: []
  });
});

test('fetchLogsForOrder skips replay when loan application logs remain empty after three attempts', async () => {
  const originalFetch = global.fetch;
  const fetchUrls = [];

  global.fetch = async (url) => {
    fetchUrls.push(url);

    if (String(url).includes('id_type=merchant_id%2Forder_id')) {
      return {
        ok: true,
        status: 200,
        statusText: 'OK',
        json: async () => ({
          result: [
            {
              message: {
                created_at: '2026-07-22T07:34:06.000Z',
                order_id: 'OD123',
                loan_application_id: 'LA-OD123-flipkart-DMI'
              }
            }
          ]
        })
      };
    }

    if (String(url).includes('id_type=loan_application_id')) {
      return {
        ok: true,
        status: 200,
        statusText: 'OK',
        json: async () => ({ result: [] })
      };
    }

    throw new Error(`Unexpected fetch URL: ${url}`);
  };

  try {
    const fetcher = new MultiSourceLogFetcher({
      sessionToken: 'session-token',
      useOrderContextLookup: false,
      retryDelay: 0,
      delayBetweenRequests: 0,
      emptyLoanApplicationLogFetchAttempts: 3
    });

    const result = await fetcher.fetchLogsForOrder('flipkart', 'OD123');

    assert.equal(result.success, true);
    assert.equal(result.skipped, true);
    assert.match(result.skipReason, /loanApplicationId logs stayed empty after 3 attempts/);
    assert.deepEqual(
      result.emptyLoanApplicationFetches,
      [{ loanApplicationId: 'LA-OD123-flipkart-DMI', attemptsUsed: 3 }]
    );
    assert.deepEqual(result.fetchDiagnostics.summary.emptyLoanApplicationIds, ['LA-OD123-flipkart-DMI']);
    assert.equal(result.fetchDiagnostics.loanApplicationFetches[0].attemptsUsed, 3);
    assert.equal(result.fetchDiagnostics.loanApplicationFetches[0].count, 0);
    assert.equal(
      fetchUrls.filter(url => String(url).includes('id_type=loan_application_id')).length,
      3
    );
  } finally {
    global.fetch = originalFetch;
  }
});

test('fetchLogsForOrder keeps replayable logs when a later loan application retry returns logs', async () => {
  const originalFetch = global.fetch;
  let loanApplicationFetchCount = 0;

  global.fetch = async (url) => {
    if (String(url).includes('id_type=merchant_id%2Forder_id')) {
      return {
        ok: true,
        status: 200,
        statusText: 'OK',
        json: async () => ({
          result: [
            {
              message: {
                created_at: '2026-07-22T07:34:06.000Z',
                order_id: 'OD123',
                loan_application_id: 'LA-OD123-flipkart-DMI'
              }
            }
          ]
        })
      };
    }

    if (String(url).includes('id_type=loan_application_id')) {
      loanApplicationFetchCount += 1;

      return {
        ok: true,
        status: 200,
        statusText: 'OK',
        json: async () => ({
          result: loanApplicationFetchCount < 3
            ? []
            : [
              {
                message: {
                  created_at: '2026-07-22T07:34:07.000Z',
                  order_id: 'OD123',
                  loan_application_id: 'LA-OD123-flipkart-DMI'
                }
              }
            ]
        })
      };
    }

    throw new Error(`Unexpected fetch URL: ${url}`);
  };

  try {
    const fetcher = new MultiSourceLogFetcher({
      sessionToken: 'session-token',
      useOrderContextLookup: false,
      retryDelay: 0,
      delayBetweenRequests: 0,
      emptyLoanApplicationLogFetchAttempts: 3
    });

    const result = await fetcher.fetchLogsForOrder('flipkart', 'OD123');

    assert.equal(result.success, true);
    assert.equal(result.skipped, undefined);
    assert.equal(result.count, 2);
    assert.deepEqual(result.context.loanApplicationIds, ['LA-OD123-flipkart-DMI']);
    assert.equal(result.fetchDiagnostics.loanApplicationFetches[0].attemptsUsed, 3);
    assert.equal(result.fetchDiagnostics.loanApplicationFetches[0].count, 1);
    assert.deepEqual(result.fetchDiagnostics.summary.emptyLoanApplicationIds, []);
  } finally {
    global.fetch = originalFetch;
  }
});
