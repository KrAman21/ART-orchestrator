import test from 'node:test';
import assert from 'node:assert/strict';

import { extractPayload, getApiMapping } from './config.js';

test('getApiMapping resolves gateway updateKYC request path', () => {
  const mapping = getApiMapping('/gateway/v3.3/kyc/updateKYCRequest', {
    payload: {},
    headers: {}
  });

  assert.deepEqual(mapping, {
    logTag: 'UpdateKYCRequest-LSP_REQUEST',
    api: '/gateway/v3.3/kyc/updateKYCRequest',
    sourceDestination: 'CORE_GATEWAY',
    headers: {}
  });
});

test('getApiMapping resolves statusKYC app-core trigger path', () => {
  const mapping = getApiMapping('/api/v3.3/kyc/statusKYC/trigger', {
    payload: {},
    headers: {}
  });

  assert.deepEqual(mapping, {
    logTag: 'StatusKYCRequest_REQUEST',
    api: '/api/v3.3/kyc/statusKYC/trigger',
    sourceDestination: 'APP_CORE',
    headers: {}
  });
});

test('getApiMapping resolves loan agreement status app-core trigger path', () => {
  const mapping = getApiMapping('/api/v1.0/loan/offers/agreementStatus/trigger', {
    payload: {},
    headers: {}
  });

  assert.deepEqual(mapping, {
    logTag: 'LOAN_AGREEMENT_STATUS_REQUEST_REQUEST',
    api: '/api/v1.0/loan/offers/agreementStatus/trigger',
    sourceDestination: 'APP_CORE',
    headers: {}
  });
});

test('getApiMapping resolves loan agreement status gateway request path', () => {
  const mapping = getApiMapping('/gateway/v3.3/loan/loanAgreementStatusRequest', {
    payload: {},
    headers: {}
  });

  assert.deepEqual(mapping, {
    logTag: 'LoanAgreementStatusTrigger_REQUEST',
    api: '/gateway/v3.3/loan/loanAgreementStatusRequest',
    sourceDestination: 'CORE_GATEWAY',
    headers: {}
  });
});

test('getApiMapping resolves check loan agreement status app-core path', () => {
  const mapping = getApiMapping('/api/v1.0/loan/offers/agreementStatus/status', {
    payload: {},
    headers: {}
  });

  assert.deepEqual(mapping, {
    logTag: 'CHECK_LOAN_AGREEMENT_STATUS_REQUEST',
    api: '/api/v1.0/loan/offers/agreementStatus/status',
    sourceDestination: 'APP_CORE',
    headers: {}
  });
});

test('getApiMapping resolves HDB status-check as loan-status when next expected replay tag requires it', () => {
  const mapping = getApiMapping('/MOCK_DATA/status-check', {
    payload: {},
    headers: {},
    nextExpectedLogTag: 'HDB_APPLICATION_STATUS_API :: LOAN_STATUS_REQUEST'
  });

  assert.deepEqual(mapping, {
    logTag: 'HDB_APPLICATION_STATUS_API :: LOAN_STATUS_REQUEST',
    api: '/MOCK_DATA/status-check',
    sourceDestination: 'GATEWAY_LENDER',
    headers: {}
  });
});

test('getApiMapping keeps HDB status-check as fetch-offer when next expected replay tag requires it', () => {
  const mapping = getApiMapping('/MOCK_DATA/status-check', {
    payload: {},
    headers: {},
    nextExpectedLogTag: 'HDB_APPLICATION_STATUS_API :: FETCH_OFFER_REQUEST'
  });

  assert.deepEqual(mapping, {
    logTag: 'HDB_APPLICATION_STATUS_API :: FETCH_OFFER_REQUEST',
    api: '/MOCK_DATA/status-check',
    sourceDestination: 'GATEWAY_LENDER',
    headers: {}
  });
});

test('getApiMapping resolves /prod/MOCK_DATA as KFS parent request when that tag is nearest in replay lookahead', () => {
  const mapping = getApiMapping('/prod/MOCK_DATA', {
    payload: {},
    headers: {},
    nextExpectedLogTag: 'UNRELATED_TAG',
    lookaheadLogTags: [
      'SOME_OTHER_REQUEST',
      'KFS SERVICE API :: PARENT_REQUEST',
      'KYC SERVICE API_REQUEST'
    ]
  });

  assert.deepEqual(mapping, {
    logTag: 'KFS SERVICE API :: PARENT_REQUEST',
    api: '/prod/MOCK_DATA',
    sourceDestination: 'GATEWAY_LENDER',
    headers: {}
  });
});

test('getApiMapping resolves /prod/MOCK_DATA as KYC request when that tag is nearest in replay lookahead', () => {
  const mapping = getApiMapping('/prod/MOCK_DATA', {
    payload: {},
    headers: {},
    nextExpectedLogTag: 'KYC SERVICE API_REQUEST',
    lookaheadLogTags: [
      'KYC SERVICE API_REQUEST',
      'KFS SERVICE API :: CHILD_REQUEST'
    ]
  });

  assert.deepEqual(mapping, {
    logTag: 'KYC SERVICE API_REQUEST',
    api: '/prod/MOCK_DATA',
    sourceDestination: 'GATEWAY_LENDER',
    headers: {}
  });
});

test('getApiMapping resolves /prod/MOCK_DATA as KFS child request when that tag is nearest in replay lookahead', () => {
  const mapping = getApiMapping('/prod/MOCK_DATA', {
    payload: {},
    headers: {},
    nextExpectedLogTag: 'UNRELATED_TAG',
    lookaheadLogTags: [
      'ANOTHER_TAG',
      'KFS SERVICE API :: CHILD_REQUEST'
    ]
  });

  assert.deepEqual(mapping, {
    logTag: 'KFS SERVICE API :: CHILD_REQUEST',
    api: '/prod/MOCK_DATA',
    sourceDestination: 'GATEWAY_LENDER',
    headers: {}
  });
});

test('getApiMapping resolves /prod/polling as line-status request when that tag is nearest in replay lookahead', () => {
  const mapping = getApiMapping('/prod/polling', {
    payload: {},
    headers: {},
    nextExpectedLogTag: 'POLLING API :: LINE_STATUS_REQUEST',
    lookaheadLogTags: [
      'POLLING API :: LINE_STATUS_REQUEST',
      'POLLING API :: FORCE_LOAN_STATUS_SYNC_REQUEST'
    ]
  });

  assert.deepEqual(mapping, {
    logTag: 'POLLING API :: LINE_STATUS_REQUEST',
    api: '/prod/polling',
    sourceDestination: 'GATEWAY_LENDER',
    headers: {}
  });
});

test('getApiMapping resolves /prod/polling as force-loan-status-sync request when that tag is nearest in replay lookahead', () => {
  const mapping = getApiMapping('/prod/polling', {
    payload: {},
    headers: {},
    nextExpectedLogTag: 'UNRELATED_TAG',
    lookaheadLogTags: [
      'SOME_OTHER_TAG',
      'POLLING API :: FORCE_LOAN_STATUS_SYNC_REQUEST'
    ]
  });

  assert.deepEqual(mapping, {
    logTag: 'POLLING API :: FORCE_LOAN_STATUS_SYNC_REQUEST',
    api: '/prod/polling',
    sourceDestination: 'GATEWAY_LENDER',
    headers: {}
  });
});

test('getApiMapping resolves /telcosprod/telcoauth as otp-generation request when that tag is next in replay lookahead', () => {
  const mapping = getApiMapping('/telcosprod/telcoauth', {
    payload: {},
    headers: {},
    nextExpectedLogTag: 'OTP GENERATION API_REQUEST',
    lookaheadLogTags: [
      'OTP GENERATION API_REQUEST',
      'OTP AUTHENTICATION API_REQUEST'
    ]
  });

  assert.deepEqual(mapping, {
    logTag: 'OTP GENERATION API_REQUEST',
    api: '/telcosprod/telcoauth',
    sourceDestination: 'GATEWAY_LENDER',
    headers: {}
  });
});

test('getApiMapping resolves /telcosprod/telcoauth as otp-authentication request when that tag is nearest in replay lookahead', () => {
  const mapping = getApiMapping('/telcosprod/telcoauth', {
    payload: {},
    headers: {},
    nextExpectedLogTag: 'UNRELATED_TAG',
    lookaheadLogTags: [
      'SOME_OTHER_TAG',
      'OTP AUTHENTICATION API_REQUEST'
    ]
  });

  assert.deepEqual(mapping, {
    logTag: 'OTP AUTHENTICATION API_REQUEST',
    api: '/telcosprod/telcoauth',
    sourceDestination: 'GATEWAY_LENDER',
    headers: {}
  });
});

test('getApiMapping resolves repeated /prod/MOCK_DATA calls in replay order using lookahead indices', () => {
  const firstMapping = getApiMapping('/prod/MOCK_DATA', {
    payload: {},
    headers: {},
    replayScopeKey: 'order-1',
    currentReplayIndex: 49,
    nextExpectedLogTag: 'KFS SERVICE API :: PARENT_REQUEST',
    lookaheadEntries: [
      { logTag: 'KFS SERVICE API :: PARENT_REQUEST', index: 49 },
      { logTag: 'KFS SERVICE API :: PARENT_RESPONSE', index: 50 },
      { logTag: 'KFS SERVICE API :: CHILD_REQUEST', index: 51 }
    ]
  });

  const secondMapping = getApiMapping('/prod/MOCK_DATA', {
    payload: {},
    headers: {},
    replayScopeKey: 'order-1',
    currentReplayIndex: 51,
    nextExpectedLogTag: 'KFS SERVICE API :: CHILD_REQUEST',
    lookaheadEntries: [
      { logTag: 'KFS SERVICE API :: PARENT_REQUEST', index: 49 },
      { logTag: 'KFS SERVICE API :: CHILD_REQUEST', index: 51 },
      { logTag: 'KFS SERVICE API :: CHILD_RESPONSE', index: 52 }
    ]
  });

  assert.deepEqual(firstMapping, {
    logTag: 'KFS SERVICE API :: PARENT_REQUEST',
    api: '/prod/MOCK_DATA',
    sourceDestination: 'GATEWAY_LENDER',
    headers: {}
  });

  assert.deepEqual(secondMapping, {
    logTag: 'KFS SERVICE API :: CHILD_REQUEST',
    api: '/prod/MOCK_DATA',
    sourceDestination: 'GATEWAY_LENDER',
    headers: {}
  });
});

test('getApiMapping keeps /prod/MOCK_DATA multitag cursor isolated per replay scope', () => {
  const firstOrderParent = getApiMapping('/prod/MOCK_DATA', {
    payload: {},
    headers: {},
    replayScopeKey: 'order-a',
    currentReplayIndex: 53,
    nextExpectedLogTag: 'KFS SERVICE API :: PARENT_REQUEST',
    lookaheadEntries: [
      { logTag: 'KFS SERVICE API :: PARENT_REQUEST', index: 53 },
      { logTag: 'KFS SERVICE API :: CHILD_REQUEST', index: 57 }
    ]
  });

  const secondOrderParent = getApiMapping('/prod/MOCK_DATA', {
    payload: {},
    headers: {},
    replayScopeKey: 'order-b',
    currentReplayIndex: 53,
    nextExpectedLogTag: 'KFS SERVICE API :: PARENT_REQUEST',
    lookaheadEntries: [
      { logTag: 'KFS SERVICE API :: PARENT_REQUEST', index: 53 },
      { logTag: 'KFS SERVICE API :: CHILD_REQUEST', index: 57 }
    ]
  });

  const firstOrderChild = getApiMapping('/prod/MOCK_DATA', {
    payload: {},
    headers: {},
    replayScopeKey: 'order-a',
    currentReplayIndex: 57,
    nextExpectedLogTag: 'KFS SERVICE API :: CHILD_REQUEST',
    lookaheadEntries: [
      { logTag: 'KFS SERVICE API :: PARENT_REQUEST', index: 53 },
      { logTag: 'KFS SERVICE API :: CHILD_REQUEST', index: 57 }
    ]
  });

  assert.equal(firstOrderParent.logTag, 'KFS SERVICE API :: PARENT_REQUEST');
  assert.equal(secondOrderParent.logTag, 'KFS SERVICE API :: PARENT_REQUEST');
  assert.equal(firstOrderChild.logTag, 'KFS SERVICE API :: CHILD_REQUEST');
});

test('extractPayload falls back to ack payload for response logs when trace_response is empty', () => {
  const payload = extractPayload(
    {
      trace_response: null,
      trace_request_ack: {
        ack: {
          error: '0',
          traceId: 'LSP123'
        }
      }
    },
    'LSP-FetchOfferRequest_RESPONSE'
  );

  assert.deepEqual(payload, {
    ack: {
      error: '0',
      traceId: 'LSP123'
    }
  });
});

test('extractPayload prefers trace_response over ack payload for response logs', () => {
  const payload = extractPayload(
    {
      trace_response: {
        status: 'SUCCESS',
        error: null
      },
      trace_request_ack: {
        ack: {
          error: '0'
        }
      }
    },
    'Some_RESPONSE'
  );

  assert.deepEqual(payload, {
    status: 'SUCCESS',
    error: null
  });
});
