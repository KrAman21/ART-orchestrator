import test from 'node:test';
import assert from 'node:assert/strict';

import { getOptionalRepeatPolicy, isPollingApiLogTag, isSelfTriggerFallbackApiLogTag } from './replay-special-cases.js';

test('FlipKart getRedirection request is treated as polling rewind checkpoint', () => {
  assert.equal(isPollingApiLogTag('FlipKart-GetRedirectionURL_REQUEST'), true);
});

test('non-polling decision request is not treated as polling checkpoint', () => {
  assert.equal(isPollingApiLogTag('DECISION API_REQUEST'), false);
});

test('loan status async response request is treated as a self-trigger fallback API', () => {
  assert.equal(isSelfTriggerFallbackApiLogTag('LOAN_STATUS_ASYNC_RESPONSE_REQUEST'), true);
});

test('generate token request is treated as a self-trigger fallback API', () => {
  assert.equal(isSelfTriggerFallbackApiLogTag('GENERATE_TOKEN_API_REQUEST'), true);
});

test('fetch loan application data request is treated as a self-trigger fallback API', () => {
  assert.equal(isSelfTriggerFallbackApiLogTag('FECTH_LOAN_APPLICATION_DATA_API_REQUEST'), true);
});

test('loan settlement pt request is treated as a self-trigger fallback API', () => {
  assert.equal(isSelfTriggerFallbackApiLogTag('LOAN_SETTLEMENT_PT_REQUEST'), false);
});

test('check eligibility lender request becomes skippable after real-time eligibility branch advances', () => {
  const policy = getOptionalRepeatPolicy({}, {
    logTag: 'CHECK ELIGIBILITY API_REQUEST',
    isRequest: true
  });

  assert.ok(policy);
  assert.equal(policy.optionalAfterSeconds, 5);
  assert.equal(policy.requirePriorProcessedOccurrence, false);
  assert.equal(policy.requireBranchAdvance, true);
  assert.deepEqual(policy.advanceWhenSeenLogTags, [
    'LSP-FetchOfferSync_REQUEST',
    'LSP-FetchOfferSync_RESPONSE',
    'FlipKart-RealTimeEligibility_RESPONSE',
    'OFFER API_REQUEST'
  ]);
});
