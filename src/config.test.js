import test from 'node:test';
import assert from 'node:assert/strict';

import { getApiMapping } from './config.js';

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
