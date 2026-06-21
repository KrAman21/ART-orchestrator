import test from 'node:test';
import assert from 'node:assert/strict';
import { compareLogsForReplay, filterAndSortLogs } from './log-fetcher.js';

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
