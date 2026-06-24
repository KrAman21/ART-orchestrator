import test from 'node:test';
import assert from 'node:assert/strict';
import {
  compareLogsForReplay,
  filterAndSortLogs,
  filterOrchestratorSkippableLogs
} from './log-fetcher.js';

function buildLog({
  messageNumber,
  createdAt = '2026-06-19T10:00:00.000Z',
  logTag,
  traceRoute = 'LENDER_GATEWAY',
  requestId = 'req-1',
  payloadField = 'trace_request'
}) {
  return {
    messageNumber,
    message: {
      created_at: createdAt,
      log_tag: logTag,
      trace_route: traceRoute,
      request_id: requestId,
      [payloadField]: { ok: true }
    }
  };
}

test('compareLogsForReplay keeps chronological order for identical timestamps', () => {
  const logs = [
    buildLog({ messageNumber: 4, logTag: 'HDB_WEBHOOK_RESPONSE', payloadField: 'trace_response' }),
    buildLog({ messageNumber: 3, logTag: 'WEBHOOK_RESPONSE', payloadField: 'trace_response' }),
    buildLog({ messageNumber: 2, logTag: 'WEBHOOK_REQUEST' }),
    buildLog({ messageNumber: 1, logTag: 'HDB_WEBHOOK_REQUEST' })
  ];

  const sortedTags = [...logs].sort(compareLogsForReplay).map(log => log.message.log_tag);

  assert.deepEqual(sortedTags, [
    'HDB_WEBHOOK_REQUEST',
    'WEBHOOK_REQUEST',
    'WEBHOOK_RESPONSE',
    'HDB_WEBHOOK_RESPONSE'
  ]);
});

test('filterAndSortLogs applies the same timestamp tie-breaker before dedupe', async () => {
  const logs = [
    buildLog({ messageNumber: 4, logTag: 'HDB_WEBHOOK_RESPONSE', payloadField: 'trace_response' }),
    buildLog({ messageNumber: 3, logTag: 'WEBHOOK_RESPONSE', payloadField: 'trace_response' }),
    buildLog({ messageNumber: 2, logTag: 'WEBHOOK_REQUEST' }),
    buildLog({ messageNumber: 1, logTag: 'HDB_WEBHOOK_REQUEST' })
  ];

  const filtered = await filterAndSortLogs(logs);

  assert.deepEqual(filtered.map(log => log.message.log_tag), [
    'HDB_WEBHOOK_REQUEST',
    'WEBHOOK_REQUEST',
    'WEBHOOK_RESPONSE',
    'HDB_WEBHOOK_RESPONSE'
  ]);
});

test('filterOrchestratorSkippableLogs keeps GATEWAY_LSP loan status async pair and drops redundant GATEWAY_CORE echo pair', async () => {
  const logs = [
    buildLog({
      messageNumber: 1,
      createdAt: '2026-06-23T11:53:42.594Z',
      logTag: 'LOAN_STATUS_ASYNC_RESPONSE_REQUEST',
      traceRoute: 'GATEWAY_LSP',
      requestId: 'loan-status-1'
    }),
    buildLog({
      messageNumber: 2,
      createdAt: '2026-06-23T11:53:43.590Z',
      logTag: 'LoanStatusResponse_REQUEST',
      traceRoute: 'GATEWAY_CORE',
      requestId: 'loan-status-1'
    }),
    buildLog({
      messageNumber: 3,
      createdAt: '2026-06-23T11:53:43.640Z',
      logTag: 'LoanStatusResponse_RESPONSE',
      traceRoute: 'GATEWAY_CORE',
      requestId: 'loan-status-1',
      payloadField: 'trace_response'
    }),
    buildLog({
      messageNumber: 4,
      createdAt: '2026-06-23T11:53:43.644Z',
      logTag: 'LOAN_STATUS_ASYNC_RESPONSE_RESPONSE',
      traceRoute: 'GATEWAY_LSP',
      requestId: 'loan-status-1',
      payloadField: 'trace_response'
    })
  ];

  const filtered = await filterOrchestratorSkippableLogs(logs);

  assert.deepEqual(
    filtered.map(log => [log.message.trace_route, log.message.log_tag]),
    [
      ['GATEWAY_LSP', 'LOAN_STATUS_ASYNC_RESPONSE_REQUEST'],
      ['GATEWAY_LSP', 'LOAN_STATUS_ASYNC_RESPONSE_RESPONSE']
    ]
  );
});
