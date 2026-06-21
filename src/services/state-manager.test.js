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
