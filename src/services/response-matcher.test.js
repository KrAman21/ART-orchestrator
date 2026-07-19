import test from 'node:test';
import assert from 'node:assert/strict';

import { findCorrespondingResponseEntry, matchesRequestContext } from './response-matcher.js';

function req(index, offerType) {
  return {
    index,
    isRequest: true,
    isResponse: false,
    source: 'CORE',
    destination: 'GATEWAY',
    sourceDestination: 'CORE_GATEWAY',
    logTag: 'LSP-FetchOfferSync_REQUEST',
    loanApplicationId: 'loan-1',
    lenderOrgId: 'FIBE',
    payload: { offerType }
  };
}

function res(index, offerType) {
  return {
    index,
    isRequest: false,
    isResponse: true,
    source: 'GATEWAY',
    destination: 'CORE',
    sourceDestination: 'CORE_GATEWAY',
    logTag: 'LSP-FetchOfferSync_RESPONSE',
    loanApplicationId: 'loan-1',
    lenderOrgId: 'FIBE',
    payload: { offerType }
  };
}

test('matchesRequestContext distinguishes fetchOfferSync responses by offerType', () => {
  assert.equal(matchesRequestContext(req(1, 'STATIC'), res(2, 'STATIC')), true);
  assert.equal(matchesRequestContext(req(1, 'STATIC'), res(2, 'REAL_TIME')), false);
});

test('findCorrespondingResponseEntry pairs repeated fetchOfferSync responses with matching offerType', () => {
  const entries = [
    req(0, 'REAL_TIME'),
    req(1, 'STATIC'),
    res(2, 'STATIC'),
    res(3, 'REAL_TIME')
  ];

  const firstRequestResponse = findCorrespondingResponseEntry(entries, entries[0], { searchAll: true, processedIndices: new Set() });
  const secondRequestResponse = findCorrespondingResponseEntry(entries, entries[1], { searchAll: true, processedIndices: new Set() });

  assert.equal(firstRequestResponse?.payload?.offerType, 'REAL_TIME');
  assert.equal(secondRequestResponse?.payload?.offerType, 'STATIC');
});
