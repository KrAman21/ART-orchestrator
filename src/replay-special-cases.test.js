import test from 'node:test';
import assert from 'node:assert/strict';

import { isPollingApiLogTag, isSelfTriggerFallbackApiLogTag } from './replay-special-cases.js';

test('FlipKart getRedirection request is treated as polling rewind checkpoint', () => {
  assert.equal(isPollingApiLogTag('FlipKart-GetRedirectionURL_REQUEST'), true);
});

test('non-polling decision request is not treated as polling checkpoint', () => {
  assert.equal(isPollingApiLogTag('DECISION API_REQUEST'), false);
});

test('loan status async response request is treated as a self-trigger fallback API', () => {
  assert.equal(isSelfTriggerFallbackApiLogTag('LOAN_STATUS_ASYNC_RESPONSE_REQUEST'), true);
});

test('loan settlement pt request is treated as a self-trigger fallback API', () => {
  assert.equal(isSelfTriggerFallbackApiLogTag('LOAN_SETTLEMENT_PT_REQUEST'), false);
});
