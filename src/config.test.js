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
