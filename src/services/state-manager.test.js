import test from 'node:test';
import assert from 'node:assert/strict';

import { StateManager } from './state-manager.js';

test('remapReplayValue remaps typed identifier aliases', () => {
  const stateManager = new StateManager();

  stateManager.registerIdentifierMapping('loanApplicationId', 'replay-la', 'local-la');
  stateManager.registerIdentifierMapping('lineDetailId', 'replay-line', 'local-line');
  stateManager.registerIdentifierMapping('merchantUserId', 'replay-mu', 'local-mu');

  const remapped = stateManager.remapReplayValue({
    loanApplicationId: 'replay-la',
    partnerRefNo: 'replay-la',
    lineId: 'replay-line',
    applicationid: 'replay-la',
    nested: {
      lineDetailId: 'replay-line',
      merchantUserId: 'replay-mu'
    },
    untouched: 'replay-line'
  });

  assert.equal(remapped.loanApplicationId, 'local-la');
  assert.equal(remapped.partnerRefNo, 'local-la');
  assert.equal(remapped.lineId, 'local-line');
  assert.equal(remapped.applicationid, 'local-la');
  assert.equal(remapped.nested.lineDetailId, 'local-line');
  assert.equal(remapped.nested.merchantUserId, 'local-mu');
  assert.equal(remapped.untouched, 'replay-line');
});

test('remapReplayValue honors DMI applicationid context as line detail id', () => {
  const stateManager = new StateManager();

  stateManager.registerIdentifierMapping('loanApplicationId', 'replay-la', 'local-la');
  stateManager.registerIdentifierMapping('lineDetailId', 'replay-line', 'local-line');

  const remapped = stateManager.remapReplayValue(
    {
      applicationid: 'replay-line',
      nested: {
        ApplicationId: 'replay-line'
      }
    },
    null,
    { logTag: 'DMI_WEBHOOK_REQUEST' }
  );

  assert.equal(remapped.applicationid, 'local-line');
  assert.equal(remapped.nested.ApplicationId, 'local-line');
});

test('registerMappingsFromPayloadPair learns identifier mappings from matched response payloads', () => {
  const stateManager = new StateManager();

  const registered = stateManager.registerMappingsFromPayloadPair(
    {
      payload: {
        loanApplicationId: 'replay-la',
        lineId: 'replay-line'
      }
    },
    {
      payload: {
        loanApplicationId: 'local-la',
        lineId: 'local-line'
      }
    }
  );

  assert.equal(registered, 2);
  assert.equal(stateManager.getMappedIdentifier('loanApplicationId', 'replay-la'), 'local-la');
  assert.equal(stateManager.getMappedIdentifier('lineDetailId', 'replay-line'), 'local-line');
});

test('registerMappingsFromPayloadPair honors log-tag-specific identifier overrides', () => {
  const stateManager = new StateManager();

  const registered = stateManager.registerMappingsFromPayloadPair(
    {
      actionsRequired: [
        { id: 'replay-action-id' }
      ]
    },
    {
      actionsRequired: [
        { id: 'local-action-id' }
      ]
    },
    { logTag: 'UpdateKYCRequest_REQUEST' }
  );

  assert.equal(registered, 1);
  assert.equal(stateManager.getMappedIdentifier('actionRequiredId', 'replay-action-id'), 'local-action-id');
});

test('registerMappingsFromPayloadPair does not let KYC service applicationid overwrite loan application mapping', () => {
  const stateManager = new StateManager();

  stateManager.registerIdentifierMapping('loanApplicationId', 'replay-la', 'local-la');

  const registered = stateManager.registerMappingsFromPayloadPair(
    {
      redirectionurl: 'https://example.test/KYC/replay-la/DMI/flipkart',
      leadid: 'lead-1',
      applicationid: 'replay-line-detail-id',
      type: 'kyc'
    },
    {
      redirectionurl: 'https://example.test/KYC/local-la/DMI/flipkart',
      leadid: 'lead-1',
      applicationid: 'local-line-detail-id',
      type: 'kyc'
    },
    { logTag: 'KYC SERVICE API_REQUEST' }
  );

  assert.equal(registered, 1);
  assert.equal(stateManager.getMappedIdentifier('loanApplicationId', 'replay-la'), 'local-la');
  assert.equal(
    stateManager.getMappedIdentifier('lineDetailId', 'replay-line-detail-id'),
    'local-line-detail-id'
  );
});

test('recordForwardedFor stores and resolves x-forwarded-for by replay context', () => {
  const stateManager = new StateManager();

  const stored = stateManager.recordForwardedFor({
    requestId: 'req-1',
    loanApplicationId: 'loan-1',
    orderId: 'order-1',
    headers: {
      'x-forwarded-for': '10.10.10.10, 127.0.0.1'
    }
  });

  assert.equal(stored, true);
  assert.equal(
    stateManager.resolveForwardedFor({ loanApplicationId: 'loan-1' }),
    '10.10.10.10, 127.0.0.1'
  );
  assert.equal(
    stateManager.resolveForwardedFor({ orderId: 'order-1' }),
    '10.10.10.10, 127.0.0.1'
  );
});
