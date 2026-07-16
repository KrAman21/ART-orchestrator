import test from 'node:test';
import assert from 'node:assert/strict';

import { getOptionalRepeatPolicy, isImmediateDirectReplayLogTag, isImmediateFutureCoreGatewayRequestLogTag, isPollingApiLogTag, isSelfTriggerFallbackApiLogTag, isToleratedBatchTimeoutApiLogTag } from './replay-special-cases.js';

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

test('verify lender otp request is treated as a self-trigger fallback API', () => {
  assert.equal(isSelfTriggerFallbackApiLogTag('VerifyLenderOTPRequest-LSP_REQUEST'), true);
});

test('generate partner auth token request is treated as an immediate direct replay API', () => {
  assert.equal(isImmediateDirectReplayLogTag('GENERATE PARTNER AUTH TOKEN_REQUEST'), true);
});

test('offer api request is treated as an immediate direct replay API', () => {
  assert.equal(isImmediateDirectReplayLogTag('OFFER API_REQUEST'), true);
});

test('trigger lender otp lsp request is treated as an immediate future CORE_GATEWAY replay API', () => {
  assert.equal(isImmediateFutureCoreGatewayRequestLogTag('TriggerLenderOTPRequest-LSP_REQUEST'), true);
});

test('fetch loan application data request is treated as a self-trigger fallback API', () => {
  assert.equal(isSelfTriggerFallbackApiLogTag('FECTH_LOAN_APPLICATION_DATA_API_REQUEST'), true);
});

test('loan settlement pt request is treated as a self-trigger fallback API', () => {
  assert.equal(isSelfTriggerFallbackApiLogTag('LOAN_SETTLEMENT_PT_REQUEST'), false);
});

test('lsp get status request is treated as a tolerated timeout replay fallback API', () => {
  assert.equal(isToleratedBatchTimeoutApiLogTag('LSP-GetStatus_REQUEST'), true);
});

test('check eligibility lender request becomes skippable after real-time eligibility branch advances', () => {
  const policy = getOptionalRepeatPolicy({}, {
    logTag: 'CHECK ELIGIBILITY API_REQUEST',
    isRequest: true
  });

  assert.ok(policy);
  assert.equal(policy.optionalAfterSeconds, 4);
  assert.equal(policy.requirePriorProcessedOccurrence, false);
  assert.equal(policy.requireBranchAdvance, false);
  assert.equal(policy.allowSkipWithoutAdvance, true);
  assert.deepEqual(policy.advanceWhenSeenLogTags, [
    'LSP-FetchOfferSync_REQUEST',
    'LSP-FetchOfferSync_RESPONSE',
    'FlipKart-RealTimeEligibility_RESPONSE',
    'OFFER API_REQUEST'
  ]);
});

test('generate partner auth token request becomes skippable after 5 seconds even without branch advance', () => {
  const policy = getOptionalRepeatPolicy({}, {
    logTag: 'GENERATE PARTNER AUTH TOKEN_REQUEST',
    isRequest: true
  });

  assert.ok(policy);
  assert.equal(policy.optionalAfterSeconds, 5);
  assert.equal(policy.requirePriorProcessedOccurrence, false);
  assert.equal(policy.allowSkipWithoutAdvance, true);
});

test('loan offer api request becomes skippable after 3 seconds once one prior occurrence was already processed', () => {
  const policy = getOptionalRepeatPolicy({}, {
    logTag: 'LOAN OFFER API_REQUEST',
    isRequest: true
  });

  assert.ok(policy);
  assert.equal(policy.optionalAfterSeconds, 3);
  assert.equal(policy.requirePriorProcessedOccurrence, true);
});

test('offer api request becomes skippable after 3 seconds once realtime eligibility branch has advanced', () => {
  const policy = getOptionalRepeatPolicy({}, {
    logTag: 'OFFER API_REQUEST',
    isRequest: true
  });

  assert.ok(policy);
  assert.equal(policy.optionalAfterSeconds, 3);
  assert.equal(policy.requirePriorProcessedOccurrence, false);
  assert.equal(policy.allowSkipWithoutAdvance, false);
  assert.deepEqual(policy.advanceWhenSeenLogTags, [
    'CHECK ELIGIBILITY API_REQUEST',
    'CHECK ELIGIBILITY API_RESPONSE',
    'LSP-FetchOfferSync_REQUEST',
    'LSP-FetchOfferSync_RESPONSE',
    'FlipKart-RealTimeEligibility_RESPONSE',
    'LOAN OFFER API_REQUEST'
  ]);
});

test('loan status api request becomes skippable after 3 seconds once one prior occurrence was already processed', () => {
  const policy = getOptionalRepeatPolicy({}, {
    logTag: 'LOAN STATUS API_REQUEST',
    isRequest: true
  });

  assert.ok(policy);
  assert.equal(policy.optionalAfterSeconds, 3);
  assert.equal(policy.requirePriorProcessedOccurrence, true);
});
