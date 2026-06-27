import test from 'node:test';
import assert from 'node:assert/strict';
import { shouldMergeLoanApplicationLogs } from './multi-source-log-fetcher.js';

function buildLog(createdAt) {
  return {
    message: {
      created_at: createdAt
    }
  };
}

test('shouldMergeLoanApplicationLogs rejects entire LAID set when any LAID log predates order start time', () => {
  const orderLogs = [
    buildLog('2026-06-25T10:00:00.000Z'),
    buildLog('2026-06-25T10:02:00.000Z'),
    buildLog('2026-06-25T10:05:00.000Z')
  ];

  const loanApplicationLogs = [
    buildLog('2026-06-25T09:58:00.000Z'),
    buildLog('2026-06-25T10:01:00.000Z'),
    buildLog('2026-06-25T10:03:00.000Z')
  ];

  assert.equal(shouldMergeLoanApplicationLogs(orderLogs, loanApplicationLogs), false);
});

test('shouldMergeLoanApplicationLogs keeps LAID set only when every LAID log is on or after order start time', () => {
  const orderLogs = [
    buildLog('2026-06-25T10:00:00.000Z'),
    buildLog('2026-06-25T10:02:00.000Z'),
    buildLog('2026-06-25T10:05:00.000Z')
  ];

  const loanApplicationLogs = [
    buildLog('2026-06-25T10:01:00.000Z'),
    buildLog('2026-06-25T10:03:00.000Z'),
    buildLog('2026-06-25T10:06:00.000Z')
  ];

  assert.equal(shouldMergeLoanApplicationLogs(orderLogs, loanApplicationLogs), true);
});
