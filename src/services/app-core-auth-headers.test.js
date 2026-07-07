import test from 'node:test';
import assert from 'node:assert/strict';

import { buildReplaySessionHeaders } from './app-core-auth-headers.js';
import { StateManager } from './state-manager.js';

test('buildReplaySessionHeaders resolves x-session-token from earlier GetLenderFlows response for SDK wrapper replay', () => {
  const entries = [
    {
      index: 0,
      logTag: 'GetLenderFlows_RESPONSE',
      loanApplicationId: 'LA-1',
      payload: {
        sessionToken: 'session-token-123'
      }
    },
    {
      index: 1,
      logTag: 'JuspaySDK-FetchStatus_REQUEST',
      sourceDestination: 'APP_WRAPPER',
      loanApplicationId: 'LA-1',
      payload: {}
    }
  ];

  const headers = buildReplaySessionHeaders(entries[1], entries);

  assert.equal(headers['x-session-token'], 'session-token-123');
});

test('buildReplaySessionHeaders prefers live replay session token over stale replay log token', () => {
  const stateManager = new StateManager();
  stateManager.updateReplayAppAuthFromResponse(
    'LA-1',
    JSON.stringify({
      payload: {
        sessionToken: 'live-session-token-456'
      }
    }),
    { logTag: 'GetLenderFlows_RESPONSE' }
  );

  const entries = [
    {
      index: 0,
      logTag: 'GetLenderFlows_RESPONSE',
      loanApplicationId: 'LA-1',
      payload: {
        sessionToken: 'stale-prod-session-token'
      }
    },
    {
      index: 1,
      logTag: 'JuspaySDK-FetchStatus_REQUEST',
      sourceDestination: 'APP_WRAPPER',
      loanApplicationId: 'LA-1',
      payload: {}
    }
  ];

  const headers = buildReplaySessionHeaders(entries[1], entries, stateManager);

  assert.equal(headers['x-session-token'], 'live-session-token-456');
});

test('buildReplaySessionHeaders falls back to current replay session token when no matching replay auth exists', () => {
  const stateManager = new StateManager();
  stateManager.setCurrentReplaySessionToken('current-live-session-token', {
    logTag: 'LSP-Eligibility_REQUEST'
  });

  const entries = [
    {
      index: 1,
      logTag: 'JuspaySDK-FetchStatus_REQUEST',
      sourceDestination: 'APP_WRAPPER',
      loanApplicationId: 'LA-2',
      payload: {}
    }
  ];

  const headers = buildReplaySessionHeaders(entries[0], entries, stateManager);

  assert.equal(headers['x-session-token'], 'current-live-session-token');
});
