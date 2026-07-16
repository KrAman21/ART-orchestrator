import test from 'node:test';
import assert from 'node:assert/strict';

import {
  extractTraceLogMethod,
  extractTraceLogUrl,
  resolveReplayEndpoint
} from './replay-request-resolver.js';

test('extractTraceLogUrl prefers nested trace_log url when present', () => {
  const rawLog = {
    message: {
      trace_log: {
        url: '/v1/themis/gateway/response?foo=bar'
      }
    }
  };

  assert.equal(extractTraceLogUrl(rawLog), '/v1/themis/gateway/response?foo=bar');
});

test('extractTraceLogMethod normalizes to uppercase', () => {
  const rawLog = {
    message: {
      trace_log: {
        method: 'post'
      }
    }
  };

  assert.equal(extractTraceLogMethod(rawLog), 'POST');
});

test('resolveReplayEndpoint keeps relative paths intact', () => {
  assert.equal(resolveReplayEndpoint('/gateway/webhook/SMICC?source=art'), '/gateway/webhook/SMICC?source=art');
});

test('resolveReplayEndpoint extracts path and query from absolute url', () => {
  assert.equal(
    resolveReplayEndpoint('https://gateway.example.com/v1/themis/gateway/response?foo=bar'),
    '/v1/themis/gateway/response?foo=bar'
  );
});
