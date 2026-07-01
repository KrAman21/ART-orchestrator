import test from 'node:test';
import assert from 'node:assert/strict';

import SessionOrchestratorRegistry, { extractRoutingIdentifiers } from './session-registry.js';

test('extractRoutingIdentifiers reads nested checkoutData orderId', () => {
  const identifiers = extractRoutingIdentifiers({
    checkoutData: {
      orderDetails: {
        orderId: 'order-nested-1'
      }
    }
  });

  assert.equal(identifiers.orderId, 'order-nested-1');
});

test('extractRoutingIdentifiers decodes orderJson fallback', () => {
  const orderJson = Buffer.from(JSON.stringify({ order_id: 'order-json-1' }), 'utf8').toString('base64');
  const identifiers = extractRoutingIdentifiers({ orderJson });

  assert.equal(identifiers.orderId, 'order-json-1');
});

test('findOrchestrator matches active session by nested orderId', () => {
  const registry = new SessionOrchestratorRegistry();
  const orchestrator = { isRunning: true };

  registry.register('session-1', orchestrator, ['order-123']);

  const matched = registry.findOrchestrator({
    checkoutData: {
      orderDetails: {
        orderId: 'order-123'
      }
    }
  });

  assert.equal(matched, orchestrator);
});

test('findOrchestrator still refuses ambiguous fallback without routing identifiers', () => {
  const registry = new SessionOrchestratorRegistry();

  registry.register('session-1', { isRunning: true }, ['order-1']);
  registry.register('session-2', { isRunning: true }, ['order-2']);

  const matched = registry.findOrchestrator({});

  assert.equal(matched, null);
});
