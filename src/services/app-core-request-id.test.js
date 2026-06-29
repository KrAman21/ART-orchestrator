import test from 'node:test';
import assert from 'node:assert/strict';

import { getAppCoreRequestId } from './app-core-request-id.js';

test('getAppCoreRequestId reuses GetAgreementData trigger replay request id for status request', () => {
  const result = getAppCoreRequestId({
    logTag: 'LSP-GetAgreementDataStatus_REQUEST',
    sourceDestination: 'APP_CORE',
    requestId: '8cea2016-bf9e-4c42-9808-6bddb75ba774',
    stateManager: {
      getReplayRequestIdForLogTag(logTag) {
        assert.equal(logTag, 'GetAgreementDataRequest_REQUEST');
        return 'LSP304e8e0d555e48fbab7281a0d80f74cc';
      }
    }
  });

  assert.deepEqual(result, {
    requestId: 'LSP304e8e0d555e48fbab7281a0d80f74cc',
    originalRequestId: '8cea2016-bf9e-4c42-9808-6bddb75ba774',
    normalized: false,
    reusedFromLogTag: 'GetAgreementDataRequest_REQUEST'
  });
});

test('getAppCoreRequestId still normalizes APP_CORE request ids when no reuse mapping exists', () => {
  const result = getAppCoreRequestId({
    logTag: 'GetLenderFlows_REQUEST',
    sourceDestination: 'APP_CORE',
    requestId: '07f47474-6c8d-43e2-a99d-7a5b72271ab1',
    stateManager: {
      getReplayRequestIdForLogTag() {
        return null;
      }
    }
  });

  assert.equal(result.originalRequestId, '07f47474-6c8d-43e2-a99d-7a5b72271ab1');
  assert.equal(result.normalized, true);
  assert.equal(result.reusedFromLogTag, null);
  assert.match(result.requestId, /^LSP[a-f0-9]{32}$/);
});
