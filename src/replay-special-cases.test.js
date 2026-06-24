import test from 'node:test';
import assert from 'node:assert/strict';

import { isPollingApiLogTag } from './replay-special-cases.js';

test('FlipKart getRedirection request is treated as polling rewind checkpoint', () => {
  assert.equal(isPollingApiLogTag('FlipKart-GetRedirectionURL_REQUEST'), true);
});

test('non-polling decision request is not treated as polling checkpoint', () => {
  assert.equal(isPollingApiLogTag('DECISION API_REQUEST'), false);
});
