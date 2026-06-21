import test from 'node:test';
import assert from 'node:assert/strict';

import { ReplayOrchestrator } from './orchestrator.js';
import { StateManager } from './services/state-manager.js';

test('registerReplayIdentifierMappings learns live IDs and normalizes future payloads', () => {
  const orchestrator = Object.create(ReplayOrchestrator.prototype);
  orchestrator.stateManager = new StateManager();
  orchestrator.config = {};
  orchestrator.orderId = 'order-1';

  orchestrator.registerReplayIdentifierMappings(
    {
      payload: {
        lineDetail: {
          lineDetailId: 'replay-line',
          merchantUserId: 'replay-mu',
          lineDetailExtensibleData: {
            lineDetailExtensibleDataId: 'replay-lded'
          }
        },
        loanApplication: {
          loanApplicationId: 'replay-la'
        }
      }
    },
    {
      payload: {
        lineDetail: {
          lineDetailId: 'local-line',
          merchantUserId: 'local-mu',
          lineDetailExtensibleData: {
            lineDetailExtensibleDataId: 'local-lded'
          }
        },
        loanApplication: {
          loanApplicationId: 'local-la'
        }
      }
    }
  );

  const normalized = orchestrator.normalizeIncomingReplayIdentifiers({
    loanApplicationId: 'replay-la',
    payload: {
      applicationid: 'replay-la',
      lineId: 'replay-line',
      loanApplicationId: 'replay-la',
      merchantUserId: 'replay-mu',
      lineDetailExtensibleDataId: 'replay-lded'
    }
  });

  assert.equal(orchestrator.stateManager.getMappedIdentifier('lineDetailId', 'replay-line'), 'local-line');
  assert.equal(orchestrator.stateManager.getMappedIdentifier('loanApplicationId', 'replay-la'), 'local-la');
  assert.equal(normalized.loanApplicationId, 'local-la');
  assert.equal(normalized.payload.applicationid, 'local-la');
  assert.equal(normalized.payload.lineId, 'local-line');
  assert.equal(normalized.payload.loanApplicationId, 'local-la');
  assert.equal(normalized.payload.merchantUserId, 'local-mu');
  assert.equal(normalized.payload.lineDetailExtensibleDataId, 'local-lded');
});

test('state manager remaps DMI applicationid to local line detail id when log tag requires it', () => {
  const orchestrator = Object.create(ReplayOrchestrator.prototype);
  orchestrator.stateManager = new StateManager();

  orchestrator.stateManager.registerIdentifierMapping('loanApplicationId', 'replay-la', 'local-la');
  orchestrator.stateManager.registerIdentifierMapping('lineDetailId', 'replay-line', 'local-line');

  const remapped = orchestrator.stateManager.remapReplayValue(
    { applicationid: 'replay-line' },
    null,
    { logTag: 'DMI_WEBHOOK_REQUEST' }
  );

  assert.equal(remapped.applicationid, 'local-line');
});
