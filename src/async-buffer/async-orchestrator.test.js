import test from 'node:test';
import assert from 'node:assert/strict';

import { AsyncReplayOrchestrator, prepareAsyncReplayForwarding } from './async-orchestrator.js';
import { LogSequenceValidator } from '../services/log-sequence-validator.js';

function createRequestLog(index, {
  logTag,
  traceRoute,
  orderId = 'order-1',
  loanApplicationId = 'loan-1',
  lenderOrgId = 'TVS_CREDIT'
}) {
  return {
    messageNumber: index,
    message: {
      log_tag: logTag,
      trace_route: traceRoute,
      order_id: orderId,
      loan_application_id: loanApplicationId,
      lender_org_id: lenderOrgId
    }
  };
}

test('uses 40 second wait timeout for skippable FETCH_OFFER_ASYNC_RESPONSE_REQUEST branch', () => {
  const orchestrator = Object.create(AsyncReplayOrchestrator.prototype);
  orchestrator.config = {
    timeoutMs: 90000
  };

  const entry = {
    logTag: 'FETCH_OFFER_ASYNC_RESPONSE_REQUEST',
    source: 'GATEWAY',
    destination: 'LSP',
    isRequest: true
  };

  const timeoutMs = orchestrator.getRequestWaitTimeoutMs(entry);
  assert.equal(timeoutMs, 40000);
});

test('uses 9 second wait timeout for self-trigger fallback LOAN_STATUS_ASYNC_RESPONSE_REQUEST branch', () => {
  const orchestrator = Object.create(AsyncReplayOrchestrator.prototype);
  orchestrator.config = {
    timeoutMs: 90000
  };

  const entry = {
    logTag: 'LOAN_STATUS_ASYNC_RESPONSE_REQUEST',
    source: 'GATEWAY',
    destination: 'LSP',
    isRequest: true
  };

  const timeoutMs = orchestrator.getRequestWaitTimeoutMs(entry);
  assert.equal(timeoutMs, 9000);
});

test('FETCH_OFFER_ASYNC_RESPONSE_REQUEST remains optional under policy evaluation', () => {
  const logs = [
    createRequestLog(0, {
      logTag: 'FETCH_OFFER_ASYNC_RESPONSE_REQUEST',
      traceRoute: 'GATEWAY_LSP'
    }),
    createRequestLog(1, {
      logTag: 'CHECK ELIGIBILITY STATUS API_REQUEST',
      traceRoute: 'GATEWAY_LENDER'
    })
  ];

  const validator = new LogSequenceValidator(logs);
  const orchestrator = Object.create(AsyncReplayOrchestrator.prototype);
  orchestrator.config = {
    timeoutMs: 90000
  };
  orchestrator.validator = validator;
  orchestrator.observedIncomingRequests = [
    {
      logTag: 'CHECK ELIGIBILITY STATUS API_REQUEST',
      orderId: 'order-1',
      loanApplicationId: 'loan-1',
      lenderOrgId: 'TVS_CREDIT'
    }
  ];
  orchestrator.observedProcessedResponses = [];

  const shouldSkip = orchestrator.shouldSkipTimedOutOptionalRequest(validator.entries[0]);
  assert.equal(shouldSkip, true);
});

test('processNextLogEntry waits briefly before skipping skippable async request', async () => {
  const logs = [
    createRequestLog(0, {
      logTag: 'FETCH_OFFER_ASYNC_RESPONSE_REQUEST',
      traceRoute: 'GATEWAY_LSP'
    }),
    {
      messageNumber: 1,
      message: {
        log_tag: 'FETCH_OFFER_ASYNC_RESPONSE_RESPONSE',
        trace_route: 'LSP_GATEWAY',
        order_id: 'order-1',
        loan_application_id: 'loan-1',
        lender_org_id: 'TVS_CREDIT'
      }
    },
    createRequestLog(2, {
      logTag: 'CHECK ELIGIBILITY STATUS API_REQUEST',
      traceRoute: 'GATEWAY_LENDER'
    })
  ];

  const validator = new LogSequenceValidator(logs);
  const orchestrator = Object.create(AsyncReplayOrchestrator.prototype);
  orchestrator.config = {
    timeoutMs: 90000
  };
  orchestrator.validator = validator;
  orchestrator.isRunning = true;
  orchestrator.observedIncomingRequests = [
    {
      logTag: 'CHECK ELIGIBILITY STATUS API_REQUEST',
      orderId: 'order-1',
      loanApplicationId: 'loan-1',
      lenderOrgId: 'TVS_CREDIT'
    }
  ];
  orchestrator.observedProcessedResponses = [];

  let waitedEntry = null;
  let waitedTimeoutMs = null;
  orchestrator.bufferManager = {
    hasMatchingBufferedRequest: () => false,
    waitForMatchingRequest: async (entry, timeoutMs) => {
      waitedEntry = entry;
      waitedTimeoutMs = timeoutMs;
      return null;
    }
  };

  const result = await AsyncReplayOrchestrator.prototype.processNextLogEntry.call(orchestrator);

  assert.equal(result, true);
  assert.equal(waitedEntry, validator.entries[0]);
  assert.equal(waitedTimeoutMs, 40000);
  assert.equal(validator.processedIndices.has(0), true);
  assert.equal(validator.currentIndex, 1);
});

test('processNextLogEntry self-triggers configured fallback API after normal wait timeout and advances replay', async () => {
  const logs = [
    createRequestLog(0, {
      logTag: 'LOAN_STATUS_ASYNC_RESPONSE_REQUEST',
      traceRoute: 'GATEWAY_LSP'
    }),
    {
      messageNumber: 1,
      message: {
        log_tag: 'LOAN_STATUS_ASYNC_RESPONSE_RESPONSE',
        trace_route: 'GATEWAY_LSP',
        order_id: 'order-1',
        loan_application_id: 'loan-1',
        lender_org_id: 'TVS_CREDIT'
      }
    }
  ];

  const validator = new LogSequenceValidator(logs);
  const orchestrator = Object.create(AsyncReplayOrchestrator.prototype);
  orchestrator.config = {
    timeoutMs: 10000
  };
  orchestrator.validator = validator;
  orchestrator.isRunning = true;
  orchestrator.observedIncomingRequests = [];
  orchestrator.observedProcessedResponses = [];

  let waitedEntry = null;
  let waitedTimeoutMs = null;
  let fallbackEntry = null;
  let fallbackTimeoutMs = null;

  orchestrator.bufferManager = {
    hasMatchingBufferedRequest: () => false,
    waitForMatchingRequest: async (entry, timeoutMs) => {
      waitedEntry = entry;
      waitedTimeoutMs = timeoutMs;
      return null;
    }
  };

  orchestrator.triggerMissingExpectedRequestFallback = async (entry, timeoutMs) => {
    fallbackEntry = entry;
    fallbackTimeoutMs = timeoutMs;
    validator.markProcessed(entry);
    const responseEntry = orchestrator.findCorrespondingResponse(entry, true);
    if (responseEntry) {
      validator.markProcessed(responseEntry);
    }
    return true;
  };

  const result = await AsyncReplayOrchestrator.prototype.processNextLogEntry.call(orchestrator);

  assert.equal(result, true);
  assert.equal(waitedEntry, validator.entries[0]);
  assert.equal(waitedTimeoutMs, 9000);
  assert.equal(fallbackEntry, validator.entries[0]);
  assert.equal(fallbackTimeoutMs, 9000);
  assert.equal(validator.processedIndices.has(0), true);
  assert.equal(validator.processedIndices.has(1), true);
});

test('prepareAsyncReplayForwarding preserves loan-status payload requestId during fallback replay', () => {
  const entry = {
    logTag: 'Lsp-LoanStatusRequest_REQUEST',
    headers: {
      'x-merchant-id': 'flipkart'
    },
    message: {
      merchant_id: 'flipkart'
    },
    loanApplicationId: 'LSP123',
    orderId: 'order-1'
  };

  const payload = {
    loanApplicationId: 'LSP123',
    requestId: 'body-request-id'
  };

  const prepared = prepareAsyncReplayForwarding(
    entry,
    payload,
    'outer-replay-request-id',
    {},
    'flipkart',
    [
      {
        logTag: 'Lsp-LoanStatusRequest_REQUEST',
        source: 'CORE',
        destination: 'GATEWAY',
        sourceDestination: 'CORE_GATEWAY',
        loanApplicationId: 'LSP123',
        orderId: 'order-1',
        payload: {
          requestId: 'another-live-request-id'
        }
      }
    ]
  );

  assert.equal(prepared.payload.requestId, 'body-request-id');
  assert.equal(prepared.replayRequestIdCandidate?.requestId, 'another-live-request-id');
});
