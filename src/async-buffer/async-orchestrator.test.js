import test from 'node:test';
import assert from 'node:assert/strict';

import { AsyncReplayOrchestrator, prepareAsyncReplayForwarding } from './async-orchestrator.js';
import { LogSequenceValidator } from '../services/log-sequence-validator.js';
import { StateManager } from '../services/state-manager.js';

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

test('uses 2 second wait timeout for self-trigger fallback GENERATE_TOKEN_API_REQUEST branch', () => {
  const orchestrator = Object.create(AsyncReplayOrchestrator.prototype);
  orchestrator.config = {
    timeoutMs: 90000
  };

  const entry = {
    logTag: 'GENERATE_TOKEN_API_REQUEST',
    source: 'GATEWAY',
    destination: 'LENDER',
    isRequest: true
  };

  const timeoutMs = orchestrator.getRequestWaitTimeoutMs(entry);
  assert.equal(timeoutMs, 2000);
});

test('uses 5 second wait timeout for self-trigger fallback FECTH_LOAN_APPLICATION_DATA_API_REQUEST branch', () => {
  const orchestrator = Object.create(AsyncReplayOrchestrator.prototype);
  orchestrator.config = {
    timeoutMs: 90000
  };

  const entry = {
    logTag: 'FECTH_LOAN_APPLICATION_DATA_API_REQUEST',
    source: 'GATEWAY',
    destination: 'LSP',
    isRequest: true
  };

  const timeoutMs = orchestrator.getRequestWaitTimeoutMs(entry);
  assert.equal(timeoutMs, 5000);
});

test('uses 3 second wait timeout for optional repeated LOAN STATUS API_REQUEST branch', () => {
  const orchestrator = Object.create(AsyncReplayOrchestrator.prototype);
  orchestrator.config = {
    timeoutMs: 90000
  };

  const entry = {
    logTag: 'LOAN STATUS API_REQUEST',
    source: 'GATEWAY',
    destination: 'LENDER',
    isRequest: true
  };

  const timeoutMs = orchestrator.getRequestWaitTimeoutMs(entry);
  assert.equal(timeoutMs, 3000);
});

test('uses 3 second wait timeout for optional repeated HDB application loan-status branch', () => {
  const orchestrator = Object.create(AsyncReplayOrchestrator.prototype);
  orchestrator.config = {
    timeoutMs: 90000
  };

  const entry = {
    logTag: 'HDB_APPLICATION_STATUS_API :: LOAN_STATUS_REQUEST',
    source: 'GATEWAY',
    destination: 'LENDER',
    isRequest: true
  };

  const timeoutMs = orchestrator.getRequestWaitTimeoutMs(entry);
  assert.equal(timeoutMs, 3000);
});

test('registerNearbyImmediateReplaySatisfaction marks a matching nearby replay entry as pre-satisfied', () => {
  const logs = [
    createRequestLog(0, {
      logTag: 'SOME_OTHER_REQUEST',
      traceRoute: 'CORE_GATEWAY'
    }),
    createRequestLog(1, {
      logTag: 'FECTH_LOAN_APPLICATION_DATA_API_REQUEST',
      traceRoute: 'GATEWAY_LSP'
    }),
    {
      messageNumber: 2,
      message: {
        log_tag: 'FECTH_LOAN_APPLICATION_DATA_API_RESPONSE',
        trace_route: 'LSP_GATEWAY',
        order_id: 'order-1',
        loan_application_id: 'loan-1',
        lender_org_id: 'TVS_CREDIT'
      }
    }
  ];

  const validator = new LogSequenceValidator(logs);
  const orchestrator = Object.create(AsyncReplayOrchestrator.prototype);
  orchestrator.validator = validator;
  orchestrator.preSatisfiedReplayEntries = new Map();
  orchestrator.recordSuccess = () => {};
  orchestrator.findCorrespondingResponse = AsyncReplayOrchestrator.prototype.findCorrespondingResponse.bind(orchestrator);

  validator.currentIndex = 0;

  const registered = AsyncReplayOrchestrator.prototype.registerNearbyImmediateReplaySatisfaction.call(
    orchestrator,
    {
      source: 'GATEWAY',
      destination: 'LSP',
      logTag: 'FECTH_LOAN_APPLICATION_DATA_API_REQUEST',
      requestId: 'live-request-id',
      loanApplicationId: 'loan-1',
      payload: {
        loanApplicationId: 'loan-1',
        requiredData: ['LOAN_APPLICATION_DATA']
      }
    },
    {
      reason: 'unit_test_immediate_nearby'
    }
  );

  assert.equal(registered, true);
  const marker = orchestrator.preSatisfiedReplayEntries.get(1);
  assert.ok(marker);
  assert.equal(marker.requestIndex, 1);
  assert.equal(marker.responseIndex, 2);
  assert.equal(marker.requestId, 'live-request-id');
});

test('maybeResolvePreSatisfiedReplayEntry marks request and response processed when replay reaches the entry', () => {
  const logs = [
    createRequestLog(0, {
      logTag: 'FECTH_LOAN_APPLICATION_DATA_API_REQUEST',
      traceRoute: 'GATEWAY_LSP'
    }),
    {
      messageNumber: 1,
      message: {
        log_tag: 'FECTH_LOAN_APPLICATION_DATA_API_RESPONSE',
        trace_route: 'LSP_GATEWAY',
        order_id: 'order-1',
        loan_application_id: 'loan-1',
        lender_org_id: 'TVS_CREDIT'
      }
    }
  ];

  const validator = new LogSequenceValidator(logs);
  const orchestrator = Object.create(AsyncReplayOrchestrator.prototype);
  orchestrator.validator = validator;
  orchestrator.preSatisfiedReplayEntries = new Map([
    [0, {
      requestIndex: 0,
      responseIndex: 1,
      requestId: 'live-request-id'
    }]
  ]);
  orchestrator.recordSuccess = () => {};

  const resolved = AsyncReplayOrchestrator.prototype.maybeResolvePreSatisfiedReplayEntry.call(
    orchestrator,
    validator.entries[0]
  );

  assert.equal(resolved, true);
  assert.equal(validator.processedIndices.has(0), true);
  assert.equal(validator.processedIndices.has(1), true);
  assert.equal(orchestrator.preSatisfiedReplayEntries.has(0), false);
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

test('GENERATE PARTNER AUTH TOKEN_REQUEST becomes optional after timeout even without branch advance', () => {
  const logs = [
    createRequestLog(0, {
      logTag: 'GENERATE PARTNER AUTH TOKEN_REQUEST',
      traceRoute: 'GATEWAY_LENDER'
    }),
    {
      messageNumber: 1,
      message: {
        log_tag: 'GENERATE PARTNER AUTH TOKEN_RESPONSE',
        trace_route: 'LENDER_GATEWAY',
        order_id: 'order-1',
        loan_application_id: 'loan-1',
        lender_org_id: 'TVS_CREDIT'
      }
    }
  ];

  const validator = new LogSequenceValidator(logs);
  const orchestrator = Object.create(AsyncReplayOrchestrator.prototype);
  orchestrator.config = {
    timeoutMs: 90000
  };
  orchestrator.validator = validator;
  orchestrator.observedIncomingRequests = [];
  orchestrator.observedProcessedResponses = [];

  const shouldSkip = orchestrator.shouldSkipTimedOutOptionalRequest(validator.entries[0]);
  assert.equal(shouldSkip, true);
});

test('LOAN OFFER API_REQUEST becomes optional after timeout when one prior occurrence was already processed', () => {
  const logs = [
    createRequestLog(0, {
      logTag: 'LOAN OFFER API_REQUEST',
      traceRoute: 'GATEWAY_LENDER'
    }),
    {
      messageNumber: 1,
      message: {
        log_tag: 'LOAN OFFER API_RESPONSE',
        trace_route: 'LENDER_GATEWAY',
        order_id: 'order-1',
        loan_application_id: 'loan-1',
        lender_org_id: 'TVS_CREDIT'
      }
    },
    createRequestLog(2, {
      logTag: 'LOAN OFFER API_REQUEST',
      traceRoute: 'GATEWAY_LENDER'
    }),
    {
      messageNumber: 3,
      message: {
        log_tag: 'LOAN OFFER API_RESPONSE',
        trace_route: 'LENDER_GATEWAY',
        order_id: 'order-1',
        loan_application_id: 'loan-1',
        lender_org_id: 'TVS_CREDIT'
      }
    }
  ];

  const validator = new LogSequenceValidator(logs);
  validator.processedIndices.add(0);
  validator.processedIndices.add(1);
  validator.currentIndex = 2;

  const orchestrator = Object.create(AsyncReplayOrchestrator.prototype);
  orchestrator.config = {
    timeoutMs: 90000
  };
  orchestrator.validator = validator;
  orchestrator.observedIncomingRequests = [];
  orchestrator.observedProcessedResponses = [];

  const shouldSkip = orchestrator.shouldSkipTimedOutOptionalRequest(validator.entries[2]);
  assert.equal(shouldSkip, true);
});

test('OFFER API_REQUEST becomes optional after timeout when realtime branch has already advanced', () => {
  const logs = [
    createRequestLog(0, {
      logTag: 'OFFER API_REQUEST',
      traceRoute: 'GATEWAY_LENDER',
      loanApplicationId: 'loan-1'
    }),
    createRequestLog(1, {
      logTag: 'CHECK ELIGIBILITY API_REQUEST',
      traceRoute: 'GATEWAY_LENDER',
      loanApplicationId: 'loan-1'
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
      logTag: 'CHECK ELIGIBILITY API_REQUEST',
      source: 'GATEWAY',
      destination: 'LENDER',
      loanApplicationId: 'loan-1'
    }
  ];
  orchestrator.observedProcessedResponses = [];
  orchestrator.bufferManager = {
    hasMatchingBufferedRequest: () => false
  };

  const shouldSkip = orchestrator.shouldSkipTimedOutOptionalRequest(validator.entries[0]);
  assert.equal(shouldSkip, true);
});

test('LOAN STATUS API_REQUEST becomes optional after timeout when one prior occurrence was already processed', () => {
  const logs = [
    createRequestLog(0, {
      logTag: 'LOAN STATUS API_REQUEST',
      traceRoute: 'GATEWAY_LENDER'
    }),
    {
      messageNumber: 1,
      message: {
        log_tag: 'LOAN STATUS API_RESPONSE',
        trace_route: 'LENDER_GATEWAY',
        order_id: 'order-1',
        loan_application_id: 'loan-1',
        lender_org_id: 'TVS_CREDIT'
      }
    },
    createRequestLog(2, {
      logTag: 'LOAN STATUS API_REQUEST',
      traceRoute: 'GATEWAY_LENDER'
    }),
    {
      messageNumber: 3,
      message: {
        log_tag: 'LOAN STATUS API_RESPONSE',
        trace_route: 'LENDER_GATEWAY',
        order_id: 'order-1',
        loan_application_id: 'loan-1',
        lender_org_id: 'TVS_CREDIT'
      }
    }
  ];

  const validator = new LogSequenceValidator(logs);
  validator.processedIndices.add(0);
  validator.processedIndices.add(1);
  validator.currentIndex = 2;

  const orchestrator = Object.create(AsyncReplayOrchestrator.prototype);
  orchestrator.config = {
    timeoutMs: 90000
  };
  orchestrator.validator = validator;
  orchestrator.observedIncomingRequests = [];
  orchestrator.observedProcessedRequests = [validator.entries[0]];
  orchestrator.observedProcessedResponses = [];

  const shouldSkip = orchestrator.shouldSkipTimedOutOptionalRequest(validator.entries[2]);
  assert.equal(shouldSkip, true);
});

test('future GATEWAY->LENDER loan status requests reserve distinct replay entries', async () => {
  const logs = [
    createRequestLog(127, {
      logTag: 'LSP-GetStatus_REQUEST',
      traceRoute: 'CORE_GATEWAY'
    }),
    createRequestLog(128, {
      logTag: 'LOAN STATUS API_REQUEST',
      traceRoute: 'GATEWAY_LENDER'
    }),
    createRequestLog(129, {
      logTag: 'LOAN STATUS API_REQUEST',
      traceRoute: 'GATEWAY_LENDER'
    }),
    {
      messageNumber: 130,
      message: {
        log_tag: 'LOAN STATUS API_RESPONSE',
        trace_route: 'LENDER_GATEWAY',
        order_id: 'order-1',
        loan_application_id: 'loan-1',
        lender_org_id: 'TVS_CREDIT'
      }
    },
    {
      messageNumber: 131,
      message: {
        log_tag: 'LOAN STATUS API_RESPONSE',
        trace_route: 'LENDER_GATEWAY',
        order_id: 'order-1',
        loan_application_id: 'loan-1',
        lender_org_id: 'TVS_CREDIT'
      }
    }
  ];

  const validator = new LogSequenceValidator(logs);
  validator.currentIndex = 0;

  const orchestrator = Object.create(AsyncReplayOrchestrator.prototype);
  orchestrator.validator = validator;
  orchestrator.preSatisfiedReplayEntries = new Map();
  orchestrator.attachBufferedRequestKeyToPreSatisfiedEntry =
    AsyncReplayOrchestrator.prototype.attachBufferedRequestKeyToPreSatisfiedEntry;
  let bufferedSequence = 0;
  orchestrator.bufferManager = {
    claimIncomingRequestByKey: key => ({ key, request: incoming }),
    addIncomingRequest: async request => ({
      key: `buffer-${++bufferedSequence}-${request.requestId || 'no-id'}-${request.logTag}`,
      deferred: { promise: Promise.resolve({ success: true }) }
    })
  };

  const incoming = {
    source: 'GATEWAY',
    destination: 'LENDER',
    logTag: 'LOAN STATUS API_REQUEST',
    requestId: null,
    lenderOrgId: 'TVS_CREDIT',
    loanApplicationId: 'loan-1'
  };

  await orchestrator.maybeHandleFutureGatewayLenderRequest(
    incoming,
    incoming,
    { foundInLookahead: validator.entries[1], isEarly: true }
  );

  await orchestrator.maybeHandleFutureGatewayLenderRequest(
    incoming,
    incoming,
    { foundInLookahead: validator.entries[1], isEarly: true }
  );

  assert.ok(orchestrator.preSatisfiedReplayEntries.has(1));
  assert.ok(orchestrator.preSatisfiedReplayEntries.has(2));
  assert.equal(
    orchestrator.preSatisfiedReplayEntries.get(1)?.bufferedRequestKey,
    'buffer-1-no-id-LOAN STATUS API_REQUEST'
  );
  assert.equal(
    orchestrator.preSatisfiedReplayEntries.get(2)?.bufferedRequestKey,
    'buffer-2-no-id-LOAN STATUS API_REQUEST'
  );
});

test('current GATEWAY->LENDER replay slot completes reserved buffered request instead of buffering a second same-slot request', async () => {
  const logs = [
    createRequestLog(127, {
      logTag: 'LSP-GetStatus_REQUEST',
      traceRoute: 'CORE_GATEWAY'
    }),
    createRequestLog(128, {
      logTag: 'LOAN STATUS API_REQUEST',
      traceRoute: 'GATEWAY_LENDER'
    }),
    {
      messageNumber: 129,
      message: {
        log_tag: 'LOAN STATUS API_RESPONSE',
        trace_route: 'LENDER_GATEWAY',
        order_id: 'order-1',
        loan_application_id: 'loan-1',
        lender_org_id: 'TVS_CREDIT',
        trace_response: { status: 'SUCCESS' }
      }
    }
  ];

  const orchestrator = new AsyncReplayOrchestrator(logs, {
    timeoutMs: 10000,
    merchantId: 'flipkart'
  });
  orchestrator.isRunning = true;
  orchestrator.validator.currentIndex = 1;

  const normalizedIncoming = {
    source: 'GATEWAY',
    destination: 'LENDER',
    api: '/MOCK_DATA/loanStatus',
    logTag: 'LOAN STATUS API_REQUEST',
    sourceDestination: 'GATEWAY_LENDER',
    payload: { data: { orderId: 'loan-1' } },
    requestId: null,
    lenderOrgId: 'TVS_CREDIT',
    loanApplicationId: 'loan-1'
  };

  const reserved = await orchestrator.bufferManager.addIncomingRequest(normalizedIncoming);
  orchestrator.registerPreSatisfiedReplayEntry(orchestrator.validator.entries[1], {
    requestId: null,
    reason: 'unit_test_reserved_current_gateway_lender',
    bufferedRequestKey: reserved.key
  });

  const response = await orchestrator.maybeHandleCurrentGatewayLenderRequest(normalizedIncoming);
  const deferredResult = await reserved.deferred.promise;

  assert.equal(response.success, true);
  assert.equal(deferredResult.success, true);
  assert.deepEqual(deferredResult.payload, response.payload);
  assert.equal(orchestrator.preSatisfiedReplayEntries.has(1), false);
  assert.equal(orchestrator.validator.processedIndices.has(1), true);
  assert.equal(orchestrator.validator.processedIndices.has(2), true);

  orchestrator.bufferManager.stop();
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
  assert.equal(validator.currentIndex, 2);
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

test('buildFailureFallbackResponse replays expected response for timed out LSP-GetStatus request', () => {
  const logs = [
    createRequestLog(130, {
      logTag: 'LSP-GetStatus_REQUEST',
      traceRoute: 'CORE_GATEWAY',
      requestId: 'req-1'
    }),
    {
      messageNumber: 131,
      message: {
        log_tag: 'LSP-GetStatus_RESPONSE',
        trace_route: 'GATEWAY_CORE',
        order_id: 'order-1',
        loan_application_id: 'loan-1',
        lender_org_id: 'TVS_CREDIT',
        trace_response: {
          payload: {
            status: 'SUCCESS',
            lastCompletedState: 'GRANTED'
          }
        }
      }
    }
  ];

  const orchestrator = new AsyncReplayOrchestrator(logs, {
    timeoutMs: 10000,
    merchantId: 'flipkart'
  });
  orchestrator.orderId = 'order-1';
  orchestrator.reportGenerator = {
    recordReplayWarning() {}
  };

  const fallback = orchestrator.buildFailureFallbackResponse(
    {
      logTag: 'LSP-GetStatus_REQUEST',
      logIndex: 0,
      requestId: 'req-1'
    },
    {
      status: 400,
      statusText: 'Bad Request',
      headers: {}
    },
    {
      error_message: 'Forwarding failed for GATEWAY /gateway/v3.3/fetchLoanStatus: Request req-1 timed out after 10000ms. Expected response for: LSP-GetStatus_RESPONSE'
    },
    null
  );

  assert.ok(fallback);
  assert.equal(fallback.reason, 'tolerated_batch_timeout_replay_response_fallback');
  assert.equal(fallback.response.error, false);
  assert.deepEqual(fallback.response.data, {
    payload: {
      status: 'SUCCESS',
      lastCompletedState: 'GRANTED'
    }
  });
});

test('processNextLogEntry self-triggers GENERATE_TOKEN_API_REQUEST after 2 second buffer wait and advances replay', async () => {
  const logs = [
    createRequestLog(0, {
      logTag: 'GENERATE_TOKEN_API_REQUEST',
      traceRoute: 'GATEWAY_LENDER'
    }),
    {
      messageNumber: 1,
      message: {
        log_tag: 'GENERATE_TOKEN_API_RESPONSE',
        trace_route: 'LENDER_GATEWAY',
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
  assert.equal(waitedTimeoutMs, 2000);
  assert.equal(fallbackEntry, validator.entries[0]);
  assert.equal(fallbackTimeoutMs, 2000);
  assert.equal(validator.processedIndices.has(0), true);
});

test('processNextLogEntry self-triggers FECTH_LOAN_APPLICATION_DATA_API_REQUEST after 5 second buffer wait and advances replay', async () => {
  const logs = [
    createRequestLog(0, {
      logTag: 'FECTH_LOAN_APPLICATION_DATA_API_REQUEST',
      traceRoute: 'GATEWAY_LSP'
    }),
    {
      messageNumber: 1,
      message: {
        log_tag: 'FECTH_LOAN_APPLICATION_DATA_API_RESPONSE',
        trace_route: 'LSP_GATEWAY',
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
  assert.equal(waitedTimeoutMs, 5000);
  assert.equal(fallbackEntry, validator.entries[0]);
  assert.equal(fallbackTimeoutMs, 5000);
  assert.equal(validator.processedIndices.has(0), true);
  assert.equal(validator.processedIndices.has(1), true);
});

test('handleIncomingRequest forwards future fetchLoanApplicationData immediately and pre-satisfies replay entry', async () => {
  const logs = [
    createRequestLog(0, {
      logTag: 'GetAgreementDataRequest-LSP_REQUEST',
      traceRoute: 'CORE_GATEWAY'
    }),
    createRequestLog(1, {
      logTag: 'FECTH_LOAN_APPLICATION_DATA_API_REQUEST',
      traceRoute: 'GATEWAY_LSP'
    }),
    {
      messageNumber: 2,
      message: {
        log_tag: 'FECTH_LOAN_APPLICATION_DATA_API_RESPONSE',
        trace_route: 'LSP_GATEWAY',
        order_id: 'order-1',
        loan_application_id: 'loan-1',
        lender_org_id: 'TVS_CREDIT'
      }
    }
  ];

  const orchestrator = new AsyncReplayOrchestrator(logs, {
    timeoutMs: 10000,
    merchantId: 'flipkart'
  });
  orchestrator.isRunning = true;

  let forwarded = null;
  orchestrator.forwardToDestination = async (incoming, expectedEntry) => {
    forwarded = {
      incoming,
      expectedEntry
    };
    return {
      success: true,
      payload: {
        status: 'SUCCESS',
        checkoutData: {
          checkoutId: 'chk-1'
        }
      }
    };
  };

  const response = await orchestrator.handleIncomingRequest({
    source: 'GATEWAY',
    destination: 'LSP',
    api: '/api/fetch/loanApplicationData',
    logTag: 'FECTH_LOAN_APPLICATION_DATA_API_REQUEST',
    sourceDestination: 'GATEWAY_LSP',
    requestId: 'live-fetch-loan-request',
    loanApplicationId: 'loan-1',
    payload: {
      loanApplicationId: 'loan-1',
      requiredData: ['CHECKOUT_DATA', 'LINE_DATA', 'SELECTED_OFFER_SERIALIZER']
    }
  });

  assert.equal(response.success, true);
  assert.ok(forwarded);
  assert.equal(forwarded.expectedEntry.index, 1);
  assert.deepEqual(forwarded.incoming.payload.requiredData, ['CHECKOUT_DATA', 'LINE_DATA', 'SELECTED_OFFER_SERIALIZER']);
  assert.equal(orchestrator.validator.processedIndices.has(1), false);

  const marker = orchestrator.preSatisfiedReplayEntries.get(1);
  assert.ok(marker);
  assert.equal(marker.requestIndex, 1);
  assert.equal(marker.responseIndex, 2);
  assert.equal(marker.requestId, 'live-fetch-loan-request');
});

test('handleIncomingRequest responds immediately for GENERATE_TOKEN_API_REQUEST and later skips the replay pair', async () => {
  const logs = [
    createRequestLog(0, {
      logTag: 'LSP-FetchOfferSync_REQUEST',
      traceRoute: 'CORE_GATEWAY'
    }),
    createRequestLog(1, {
      logTag: 'GENERATE_TOKEN_API_REQUEST',
      traceRoute: 'GATEWAY_LENDER'
    }),
    {
      messageNumber: 2,
      message: {
        log_tag: 'GENERATE_TOKEN_API_RESPONSE',
        trace_route: 'LENDER_GATEWAY',
        order_id: 'order-1',
        loan_application_id: 'loan-1',
        lender_org_id: 'TVS_CREDIT'
      }
    }
  ];

  const orchestrator = new AsyncReplayOrchestrator(logs, {
    timeoutMs: 10000,
    merchantId: 'flipkart'
  });
  orchestrator.isRunning = true;

  const response = await orchestrator.handleIncomingRequest({
    source: 'GATEWAY',
    destination: 'LENDER',
    api: '/merchant-auth-qa/esapi/generateToken',
    logTag: 'GENERATE_TOKEN_API_REQUEST',
    sourceDestination: 'GATEWAY_LENDER',
    payload: { username: 'flipkart', password: 'secret' },
    requestId: 'req-1'
  });

  assert.equal(response.success, true);
  assert.equal(response.synthetic, true);
  assert.equal(orchestrator.validator.processedIndices.has(1), false);
  assert.equal(orchestrator.validator.processedIndices.has(2), false);

  const resolved = orchestrator.maybeResolvePreSatisfiedReplayEntry(orchestrator.validator.entries[1]);
  assert.equal(resolved, true);
  assert.equal(orchestrator.validator.processedIndices.has(1), true);
  assert.equal(orchestrator.validator.processedIndices.has(2), true);

  orchestrator.bufferManager.stop();
});

test('handleIncomingRequest responds immediately for GENERATE PARTNER AUTH TOKEN_REQUEST and later skips the replay pair', async () => {
  const logs = [
    createRequestLog(0, {
      logTag: 'LSP-FetchOfferSync_REQUEST',
      traceRoute: 'CORE_GATEWAY'
    }),
    createRequestLog(1, {
      logTag: 'GENERATE PARTNER AUTH TOKEN_REQUEST',
      traceRoute: 'GATEWAY_LENDER'
    }),
    {
      messageNumber: 2,
      message: {
        log_tag: 'GENERATE PARTNER AUTH TOKEN_RESPONSE',
        trace_route: 'LENDER_GATEWAY',
        order_id: 'order-1',
        loan_application_id: 'loan-1',
        lender_org_id: 'TVS_CREDIT'
      }
    }
  ];

  const orchestrator = new AsyncReplayOrchestrator(logs, {
    timeoutMs: 10000,
    merchantId: 'flipkart'
  });
  orchestrator.isRunning = true;

  const response = await orchestrator.handleIncomingRequest({
    source: 'GATEWAY',
    destination: 'LENDER',
    api: '/prod/generateToken',
    logTag: 'GENERATE PARTNER AUTH TOKEN_REQUEST',
    sourceDestination: 'GATEWAY_LENDER',
    payload: { username: 'flipkart' },
    requestId: 'partner-auth-1'
  });

  assert.equal(response.success, true);
  assert.equal(orchestrator.validator.processedIndices.has(1), false);
  assert.equal(orchestrator.validator.processedIndices.has(2), false);

  const resolved = orchestrator.maybeResolvePreSatisfiedReplayEntry(orchestrator.validator.entries[1]);
  assert.equal(resolved, true);
  assert.equal(orchestrator.validator.processedIndices.has(1), true);
  assert.equal(orchestrator.validator.processedIndices.has(2), true);

  orchestrator.bufferManager.stop();
});

test('handleIncomingRequest records unexpected actual gateway-side APIs that are absent from replay sequence', async () => {
  const logs = [
    createRequestLog(0, {
      logTag: 'SetRepaymentPlanRequest-LSP_REQUEST',
      traceRoute: 'CORE_GATEWAY'
    }),
    {
      messageNumber: 1,
      message: {
        log_tag: 'SetRepaymentPlanRequest-LSP_RESPONSE',
        trace_route: 'GATEWAY_CORE',
        order_id: 'order-1',
        loan_application_id: 'loan-1',
        lender_org_id: 'DMI'
      }
    }
  ];

  const recordedUnexpectedApis = [];
  const orchestrator = new AsyncReplayOrchestrator(logs, {
    timeoutMs: 10000,
    merchantId: 'flipkart'
  });
  orchestrator.isRunning = true;
  orchestrator.orderId = 'order-1';
  orchestrator.reportGenerator = {
    recordUnexpectedActualApi(orderId, apiInfo) {
      recordedUnexpectedApis.push({ orderId, apiInfo });
    },
    recordReplayWarning() {}
  };

  orchestrator.handleIncomingRequest({
    source: 'GATEWAY',
    destination: 'LENDER',
    api: '/prod/polling',
    logTag: 'POLLING API :: LINE_STATUS_REQUEST',
    sourceDestination: 'GATEWAY_LENDER',
    payload: {
      applicationid: 'live-line-detail'
    },
    requestId: 'unexpected-1'
  }).catch(() => {});

  await new Promise(resolve => setTimeout(resolve, 0));

  assert.equal(recordedUnexpectedApis.length, 1);
  assert.equal(recordedUnexpectedApis[0].orderId, 'order-1');
  assert.equal(recordedUnexpectedApis[0].apiInfo.logTag, 'POLLING API :: LINE_STATUS_REQUEST');
  assert.equal(recordedUnexpectedApis[0].apiInfo.sourceDestination, 'GATEWAY_LENDER');

  orchestrator.bufferManager.stop();
});

test('processNextLogEntry reuses in-flight processing for the same self-trigger fallback entry', async () => {
  const logs = [
    createRequestLog(0, {
      logTag: 'Lsp-LoanStatusRequest_REQUEST',
      traceRoute: 'CORE_GATEWAY'
    }),
    {
      messageNumber: 1,
      message: {
        log_tag: 'Lsp-LoanStatusRequest_RESPONSE',
        trace_route: 'GATEWAY_CORE',
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
  orchestrator.inFlightEntryProcessing = new Map();
  orchestrator.triggerMissingExpectedRequestFallback = async entry => {
    validator.markProcessed(entry);
    const responseEntry = orchestrator.findCorrespondingResponse(entry, true);
    if (responseEntry) {
      validator.markProcessed(responseEntry);
    }
    return true;
  };

  let waitInvocationCount = 0;
  let releaseWait = null;
  orchestrator.bufferManager = {
    hasMatchingBufferedRequest: () => false,
    waitForMatchingRequest: () => {
      waitInvocationCount += 1;
      return new Promise(resolve => {
        releaseWait = resolve;
      });
    }
  };

  const firstCall = AsyncReplayOrchestrator.prototype.processNextLogEntry.call(orchestrator);
  const secondCall = AsyncReplayOrchestrator.prototype.processNextLogEntry.call(orchestrator);

  await Promise.resolve();

  assert.equal(waitInvocationCount, 1);

  releaseWait(null);
  const [firstResult, secondResult] = await Promise.all([firstCall, secondCall]);

  assert.equal(firstResult, true);
  assert.equal(secondResult, true);
  assert.equal(orchestrator.inFlightEntryProcessing.size, 0);
});

test('processOneCycle force-recovers stalled LENDER to GATEWAY webhook request after idle cycles', async () => {
  const logs = [
    createRequestLog(0, {
      logTag: 'DMI_WEBHOOK_REQUEST',
      traceRoute: 'LENDER_GATEWAY',
      lenderOrgId: 'DMI'
    }),
    {
      messageNumber: 1,
      message: {
        log_tag: 'DMI_WEBHOOK_RESPONSE',
        trace_route: 'LENDER_GATEWAY',
        order_id: 'order-1',
        loan_application_id: 'loan-1',
        lender_org_id: 'DMI'
      }
    }
  ];

  const validator = new LogSequenceValidator(logs);
  const orchestrator = Object.create(AsyncReplayOrchestrator.prototype);
  orchestrator.validator = validator;
  orchestrator.lastIdleExternalEntryKey = null;
  orchestrator.idleExternalEntryCycles = 0;
  orchestrator.checkBufferedResponses = async () => false;
  orchestrator.processNextLogEntry = async () => false;

  let recoveredEntry = null;
  orchestrator.triggerExternalRequestAsync = async entry => {
    recoveredEntry = entry;
    validator.markProcessed(entry);
    return { success: true };
  };

  const firstCycle = await AsyncReplayOrchestrator.prototype.processOneCycle.call(orchestrator);
  const secondCycle = await AsyncReplayOrchestrator.prototype.processOneCycle.call(orchestrator);

  assert.equal(firstCycle, false);
  assert.equal(secondCycle, true);
  assert.equal(recoveredEntry, validator.entries[0]);
  assert.equal(validator.processedIndices.has(0), true);
});

test('resolveOutboundLoanApplicationIdForReplay keeps current replay loan application id when buffered candidate is actually a line detail id', () => {
  const orchestrator = Object.create(AsyncReplayOrchestrator.prototype);
  orchestrator.stateManager = new StateManager();
  orchestrator.stateManager.seedProdLoanApplicationIdsFromLogs([
    {
      payload: {
        loan_application_id: 'prod-la'
      }
    }
  ]);
  orchestrator.stateManager.setCurrentReplayLoanApplicationId('live-la', {
    logTag: 'LSP-FetchOfferSync_RESPONSE'
  });
  orchestrator.bufferManager = {
    incomingRequests: new Map([
      ['bad-candidate', {
        timestamp: Date.now(),
        request: {
          source: 'GATEWAY',
          destination: 'LSP',
          sourceDestination: 'GATEWAY_LSP',
          logTag: 'WEBHOOK_REQUEST',
          orderId: 'order-1',
          loanApplicationId: 'live-line-detail-id',
          payload: {
            loanApplicationId: 'live-line-detail-id',
            lineDetail: {
              lineDetailId: 'live-line-detail-id'
            }
          }
        }
      }]
    ]),
    responseBuffer: new Map()
  };
  orchestrator.observedIncomingRequests = [];

  const resolved = orchestrator.resolveOutboundLoanApplicationIdForReplay({
    logTag: 'LOAN_SETTLEMENT_PT_REQUEST',
    loanApplicationId: 'prod-la',
    orderId: 'order-1',
    lenderOrgId: null
  }, {
    allowInferenceFromLiveBuffer: true
  });

  assert.equal(resolved, 'live-la');
});

test('maybePrimeLoanSettlementPt waits before triggering replay helper', async () => {
  const orchestrator = Object.create(AsyncReplayOrchestrator.prototype);
  orchestrator.stateManager = new StateManager();
  orchestrator.stateManager.seedProdLoanApplicationIdsFromLogs([
    {
      payload: {
        loan_application_id: 'prod-la'
      }
    }
  ]);
  orchestrator.stateManager.setCurrentReplayLoanApplicationId('live-la', {
    logTag: 'LSP-FetchOfferSync_RESPONSE'
  });
  orchestrator.replayMerchantId = 'flipkart';
  orchestrator.config = { merchantId: 'flipkart' };
  orchestrator.validator = { currentIndex: 10 };
  orchestrator.activeLoanSettlementPtTriggers = new Set();
  orchestrator.hasWaitedForInitialLoanSettlementPtTrigger = false;
  global.setTimeout = (fn, ms, ...args) => {
    timeouts.push(ms);
    return originalSetTimeout(fn, 0, ...args);
  };

  try {
    await orchestrator.maybePrimeLoanSettlementPt({
      index: 12,
      logTag: 'LOAN_SETTLEMENT_PT_REQUEST',
      isRequest: true,
      toString: () => '[12] LOAN_SETTLEMENT_PT_REQUEST CORE→GATEWAY'
    });

    orchestrator.validator.currentIndex = 11;
    await orchestrator.maybePrimeLoanSettlementPt({
      index: 13,
      logTag: 'LOAN_SETTLEMENT_PT_REQUEST',
      isRequest: true,
      toString: () => '[13] LOAN_SETTLEMENT_PT_REQUEST CORE→GATEWAY'
    });
  } finally {
    global.setTimeout = originalSetTimeout;
  }

  assert.equal(timeouts.filter(ms => ms === 1000).length, 1);
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

test('prepareAsyncReplayForwarding adds SDK headers when log tag contains SDK', () => {
  const entry = {
    headers: {},
    logTag: 'LSP-LoanStatus_SDK_REQUEST',
    sourceDestination: 'CORE_GATEWAY',
    message: {
      merchant_id: 'flipkart'
    },
    payload: {}
  };

  const prepared = prepareAsyncReplayForwarding(
    entry,
    {},
    'outer-replay-request-id',
    {},
    'flipkart',
    []
  );

  assert.equal(prepared.headers['x-origin'], 'SDK');
  assert.equal(prepared.headers['x-version'], 'V1');
});

test('prepareAsyncReplayForwarding rewrites all maintained replay ids for APP_WRAPPER style replay payloads and headers', () => {
  const stateManager = new StateManager();
  stateManager.seedProdLoanApplicationIdsFromLogs([{ payload: { loanApplicationId: 'prod-la-1' } }]);
  stateManager.seedProdAgreementIdsFromLogs([{ payload: { agreementId: 'prod-agreement-1' } }]);
  stateManager.seedProdSessionTokensFromLogs([{ payload: { sessionToken: 'prod-session-1' } }]);
  stateManager.seedProdTxnRefIdsFromLogs([{ payload: { txnRefId: 'prod-txn-1' } }]);
  stateManager.seedProdCustomerIdsFromLogs([{ payload: { customerId: 'prod-customer-1' } }]);

  stateManager.setCurrentReplayLoanApplicationId('live-la-1', { logTag: 'JuspaySDK-FetchStatus_REQUEST' });
  stateManager.setCurrentReplayAgreementId('live-agreement-1', { logTag: 'GetAgreementDataRequest-LSP_RESPONSE' });
  stateManager.setCurrentReplaySessionToken('live-session-1', { logTag: 'GetLenderFlows_RESPONSE' });
  stateManager.setCurrentReplayTxnRefId('live-txn-1', { logTag: 'DMI_CREATE_TXN_REQUEST' });
  stateManager.setCurrentReplayCustomerId('live-customer-1', { logTag: 'LSP-Eligibility_REQUEST' });

  const entry = {
    headers: {
      'x-loan-application-id': 'prod-la-1',
      'x-session-token': 'prod-session-1'
    },
    logTag: 'JuspaySDK-FetchStatus_REQUEST',
    sourceDestination: 'APP_WRAPPER',
    loanApplicationId: 'prod-la-1',
    message: {
      merchant_id: 'flipkart'
    }
  };

  const prepared = prepareAsyncReplayForwarding(
    entry,
    {
      loanApplicationId: 'prod-la-1',
      agreementId: 'prod-agreement-1',
      sessionToken: 'prod-session-1',
      txnRefId: 'prod-txn-1',
      customerId: 'prod-customer-1',
      nested: {
        loan_application_id: 'prod-la-1',
        agreement_id: 'prod-agreement-1',
        txn_ref_id: 'prod-txn-1',
        merchant_customer_id: 'prod-customer-1'
      }
    },
    'outer-replay-request-id',
    {},
    'flipkart',
    [],
    stateManager
  );

  assert.equal(prepared.headers['x-loan-application-id'], 'live-la-1');
  assert.equal(prepared.headers['x-session-token'], 'live-session-1');
  assert.equal(prepared.payload.loanApplicationId, 'live-la-1');
  assert.equal(prepared.payload.agreementId, 'live-agreement-1');
  assert.equal(prepared.payload.sessionToken, 'live-session-1');
  assert.equal(prepared.payload.txnRefId, 'live-txn-1');
  assert.equal(prepared.payload.customerId, 'live-customer-1');
  assert.equal(prepared.payload.nested.loan_application_id, 'live-la-1');
  assert.equal(prepared.payload.nested.agreement_id, 'live-agreement-1');
  assert.equal(prepared.payload.nested.txn_ref_id, 'live-txn-1');
  assert.equal(prepared.payload.nested.merchant_customer_id, 'live-customer-1');
});

test('prepareAsyncReplayForwarding normalizes final HDB webhook payload identifiers before send', () => {
  const stateManager = new StateManager();
  stateManager.seedProdLoanApplicationIdsFromLogs([
    {
      payload: {
        loan_application_id: 'prod-la-1'
      }
    }
  ]);
  stateManager.setCurrentReplayLoanApplicationId('live-la-1', {
    logTag: 'LSP-FetchOfferSync_RESPONSE'
  });

  const entry = {
    headers: {
      'x-merchant-id': 'flipkart'
    },
    logTag: 'HDB_WEBHOOK_REQUEST',
    sourceDestination: 'LENDER_GATEWAY',
    loanApplicationId: 'prod-la-1',
    message: {
      merchant_id: 'flipkart'
    }
  };

  const prepared = prepareAsyncReplayForwarding(
    entry,
    {
      data: {
        loanApplicationId: 'live-la-1',
        applicationId: 'HF20251076901450623',
        partnerRefNo: 'HF20251076901450623',
        loan_status: 'KYC_INITIATED',
        reAttempt: true
      }
    },
    'replay-request-id',
    {},
    'flipkart',
    [],
    stateManager
  );

  assert.equal(prepared.payload.data.loanApplicationId, 'live-la-1');
  assert.equal(prepared.payload.data.applicationId, 'live-la-1');
  assert.equal(prepared.payload.data.partnerRefNo, 'live-la-1');
});

test('processNextLogEntry waits for incoming CORE->GATEWAY fetchOfferSync request instead of proactively sending it', async () => {
  const logs = [
    createRequestLog(0, {
      logTag: 'LSP-FetchOfferSync_REQUEST',
      traceRoute: 'CORE_GATEWAY'
    })
  ];

  const validator = new LogSequenceValidator(logs);
  const orchestrator = Object.create(AsyncReplayOrchestrator.prototype);
  orchestrator.config = {
    timeoutMs: 90000
  };
  orchestrator.validator = validator;
  orchestrator.isRunning = true;
  orchestrator.observedIncomingRequests = [];
  orchestrator.observedProcessedResponses = [];

  let waitedEntry = null;
  let triggerCalled = false;

  orchestrator.bufferManager = {
    hasMatchingBufferedRequest: () => false,
    waitForMatchingRequest: async entry => {
      waitedEntry = entry;
      return null;
    }
  };

  orchestrator.triggerExternalRequestAsync = async () => {
    triggerCalled = true;
    return true;
  };

  const result = await AsyncReplayOrchestrator.prototype.processNextLogEntry.call(orchestrator);

  assert.equal(result, false);
  assert.equal(waitedEntry, validator.entries[0]);
  assert.equal(triggerCalled, false);
});

test('handleIncomingRequest processes future tolerated-batch request immediately while current entry is an earlier batch response', async () => {
  const logs = [
    {
      messageNumber: 0,
      message: {
        log_tag: 'FlipKart-RealTimeEligibility_REQUEST',
        trace_route: 'APP_WRAPPER',
        order_id: 'order-1',
        client_request_id: 'client-1',
        trace_request: { order_id: 'order-1' }
      }
    },
    {
      messageNumber: 1,
      message: {
        log_tag: 'LSP-FetchOfferSync_REQUEST',
        trace_route: 'CORE_GATEWAY',
        order_id: 'order-1',
        loan_application_id: 'loan-1',
        trace_request: {
          requestId: 'prod-fetch-1',
          offerType: 'REAL_TIME',
          loanApplicationId: 'loan-1'
        }
      }
    },
    {
      messageNumber: 2,
      message: {
        log_tag: 'LSP-FetchOfferSync_RESPONSE',
        trace_route: 'GATEWAY_CORE',
        order_id: 'order-1',
        loan_application_id: 'loan-1',
        trace_response: {
          status: 'SUCCESS',
          offerType: 'REAL_TIME'
        }
      }
    },
    {
      messageNumber: 3,
      message: {
        log_tag: 'FlipKart-InitaiteTxn_REQUEST',
        trace_route: 'APP_WRAPPER',
        order_id: 'order-1',
        loan_application_id: 'loan-1',
        trace_request: {
          order_id: 'order-1',
          loanApplicationId: 'loan-1'
        }
      }
    }
  ];

  const orchestrator = Object.create(AsyncReplayOrchestrator.prototype);
  orchestrator.validator = new LogSequenceValidator(logs);
  orchestrator.validator.markProcessed(orchestrator.validator.entries[0]);
  orchestrator.validator.markProcessed(orchestrator.validator.entries[1]);
  orchestrator.validator.currentIndex = 2;
  orchestrator.preSatisfiedReplayEntries = new Map();
  orchestrator.observedIncomingRequests = [];
  orchestrator.observedProcessedResponses = [];
  orchestrator.registerPreSatisfiedReplayEntry =
    AsyncReplayOrchestrator.prototype.registerPreSatisfiedReplayEntry;
  orchestrator.findCorrespondingResponse =
    AsyncReplayOrchestrator.prototype.findCorrespondingResponse;

  let handledValidation = null;
  orchestrator.outOfOrderHandler = {
    handleOutOfOrderRequest: async (_incoming, validation) => {
      handledValidation = validation;
      return { success: true, handled: 'future-batch' };
    }
  };

  const incoming = {
    source: 'APP',
    destination: 'WRAPPER',
    api: '/flipkart/txn/initiate',
    requestId: 'live-initiate-1',
    logTag: 'FlipKart-InitaiteTxn_REQUEST',
    loanApplicationId: 'loan-1'
  };

  const validation = {
    foundInLookahead: orchestrator.validator.entries[3]
  };

  const result = await AsyncReplayOrchestrator.prototype.maybeHandleFutureToleratedBatchRequest.call(
    orchestrator,
    incoming,
    incoming,
    validation
  );

  assert.deepEqual(result, { success: true, handled: 'future-batch' });
  assert.equal(handledValidation?.expectedEntry?.index, 2);
  assert.equal(handledValidation?.foundInLookahead?.index, 3);
  assert.equal(orchestrator.preSatisfiedReplayEntries.get(3)?.reason, 'immediate_future_tolerated_batch_request');
});

test('buildFailureFallbackResponse uses matching replay response for tolerated FlipKart real-time eligibility timeout', () => {
  const logs = [
    {
      messageNumber: 0,
      message: {
        log_tag: 'FlipKart-RealTimeEligibility_REQUEST',
        trace_route: 'APP_WRAPPER',
        order_id: 'order-1',
        client_request_id: 'client-1',
        trace_request: {
          order_id: 'order-1'
        }
      }
    },
    {
      messageNumber: 1,
      message: {
        log_tag: 'FlipKart-RealTimeEligibility_RESPONSE',
        trace_route: 'APP_WRAPPER',
        order_id: 'order-1',
        client_request_id: 'client-1',
        trace_response: {
          status: 'SUCCESS',
          eligibility: {
            lender_code: 'DMI'
          }
        }
      }
    },
    {
      messageNumber: 2,
      message: {
        log_tag: 'FlipKart-RealTimeEligibility_REQUEST',
        trace_route: 'APP_WRAPPER',
        order_id: 'order-1',
        client_request_id: 'client-2',
        trace_request: {
          order_id: 'order-1'
        }
      }
    },
    {
      messageNumber: 3,
      message: {
        log_tag: 'FlipKart-RealTimeEligibility_RESPONSE',
        trace_route: 'APP_WRAPPER',
        order_id: 'order-1',
        client_request_id: 'client-2',
        trace_response: {
          status: 'SUCCESS',
          eligibility: {
            lender_code: 'DMI',
            round: 2
          }
        }
      }
    }
  ];

  const orchestrator = new AsyncReplayOrchestrator(logs, {
    timeoutMs: 10000,
    orderId: 'order-1'
  });

  const fallback = orchestrator.buildFailureFallbackResponse(
    {
      logTag: 'FlipKart-RealTimeEligibility_REQUEST',
      logIndex: 0,
      requestId: 'req-1'
    },
    {
      status: 200,
      statusText: 'OK',
      data: '{"status":"FAILURE","error":{"error_message":"No response from eligibility core within timeout"}}'
    },
    {
      error_message: 'No response from eligibility core within timeout'
    },
    null
  );

  assert.ok(fallback);
  assert.equal(fallback.reason, 'tolerated_batch_timeout_replay_response_fallback');
  assert.equal(fallback.postBatchConfirmationRequired, false);
  assert.deepEqual(fallback.response.data, {
    status: 'SUCCESS',
    eligibility: {
      lender_code: 'DMI'
    }
  });
});

test('buildFailureFallbackResponse skips post-batch confirmation for FlipKart real-time eligibility when replay response is available', () => {
  const logs = [
    {
      messageNumber: 0,
      message: {
        log_tag: 'FlipKart-RealTimeEligibility_REQUEST',
        trace_route: 'APP_WRAPPER',
        order_id: 'order-1',
        client_request_id: 'client-1',
        trace_request: {
          order_id: 'order-1'
        }
      }
    },
    {
      messageNumber: 1,
      message: {
        log_tag: 'FlipKart-RealTimeEligibility_RESPONSE',
        trace_route: 'APP_WRAPPER',
        order_id: 'order-1',
        client_request_id: 'client-1',
        trace_response: {
          status: 'SUCCESS'
        }
      }
    }
  ];

  const orchestrator = new AsyncReplayOrchestrator(logs, {
    timeoutMs: 10000,
    orderId: 'order-1'
  });

  const fallback = orchestrator.buildFailureFallbackResponse(
    {
      logTag: 'FlipKart-RealTimeEligibility_REQUEST',
      logIndex: 0,
      requestId: 'req-1'
    },
    {
      status: 200,
      statusText: 'OK',
      data: '{"status":"FAILURE","error":{"error_message":"No response from eligibility core within timeout"}}'
    },
    {
      error_message: 'No response from eligibility core within timeout'
    },
    null
  );

  assert.ok(fallback);
  assert.equal(fallback.postBatchConfirmationRequired, false);
  assert.equal(orchestrator.pendingPostBatchConfirmations.has(1), false);
});

test('buildFailureFallbackResponse uses matching replay response for tolerated LSP fetchOfferSync timeout', () => {
  const logs = [
    {
      messageNumber: 0,
      message: {
        log_tag: 'LSP-FetchOfferSync_REQUEST',
        trace_route: 'CORE_GATEWAY',
        order_id: 'order-1',
        loan_application_id: 'loan-1',
        client_request_id: 'client-1',
        trace_request: {
          requestId: 'prod-request-1',
          offerType: 'REAL_TIME',
          loanApplicationId: 'loan-1'
        }
      }
    },
    {
      messageNumber: 1,
      message: {
        log_tag: 'LSP-FetchOfferSync_RESPONSE',
        trace_route: 'GATEWAY_CORE',
        order_id: 'order-1',
        loan_application_id: 'loan-1',
        client_request_id: 'client-1',
        trace_response: {
          status: 'SUCCESS',
          loanApplicationId: 'loan-1',
          offerType: 'REAL_TIME'
        }
      }
    }
  ];

  const orchestrator = new AsyncReplayOrchestrator(logs, {
    timeoutMs: 10000,
    orderId: 'order-1'
  });

  const fallback = orchestrator.buildFailureFallbackResponse(
    {
      logTag: 'LSP-FetchOfferSync_REQUEST',
      logIndex: 0,
      requestId: 'live-request-1'
    },
    {
      status: 0,
      statusText: null,
      data: '',
      message: 'Request timeout'
    },
    {
      message: 'Request timeout'
    },
    null
  );

  assert.ok(fallback);
  assert.equal(fallback.reason, 'tolerated_batch_timeout_replay_response_fallback');
  assert.equal(fallback.postBatchConfirmationRequired, true);
  assert.equal(fallback.postBatchConfirmationResponseIndex, 1);
  assert.deepEqual(fallback.response.data, {
    status: 'SUCCESS',
    loanApplicationId: 'loan-1',
    offerType: 'REAL_TIME'
  });
});

test('buildFailureFallbackResponse uses matching replay response for tolerated GetAgreementDataRequest-LSP timeout', () => {
  const logs = [
    {
      messageNumber: 0,
      message: {
        log_tag: 'GetAgreementDataRequest-LSP_REQUEST',
        trace_route: 'CORE_GATEWAY',
        order_id: 'order-1',
        loan_application_id: 'loan-1',
        trace_request: {
          loanApplicationId: 'loan-1',
          applicationType: 'LINE_TXN'
        }
      }
    },
    {
      messageNumber: 1,
      message: {
        log_tag: 'GetAgreementDataRequest-LSP_RESPONSE',
        trace_route: 'CORE_GATEWAY',
        order_id: 'order-1',
        loan_application_id: 'loan-1',
        trace_response: {
          status: 'SUCCESS',
          agreementUrl: 'https://example.test/agreement'
        }
      }
    }
  ];

  const orchestrator = new AsyncReplayOrchestrator(logs, {
    timeoutMs: 10000,
    orderId: 'order-1'
  });

  const fallback = orchestrator.buildFailureFallbackResponse(
    {
      logTag: 'GetAgreementDataRequest-LSP_REQUEST',
      logIndex: 0,
      requestId: 'req-1'
    },
    {
      status: 0,
      statusText: 'Timeout',
      data: null,
      message: 'Request timeout'
    },
    null,
    new Error('Request timeout')
  );

  assert.ok(fallback);
  assert.equal(fallback.reason, 'tolerated_batch_timeout_replay_response_fallback');
  assert.equal(fallback.postBatchConfirmationRequired, true);
  assert.deepEqual(fallback.response.data, {
    status: 'SUCCESS',
    agreementUrl: 'https://example.test/agreement'
  });
});

test('buildFailureFallbackResponse uses matching replay response for tolerated FlipKart create-loan timeout', () => {
  const logs = [
    {
      messageNumber: 0,
      message: {
        log_tag: 'FlipKart-CreateLoan_REQUEST',
        trace_route: 'APP_WRAPPER',
        order_id: 'order-1',
        loan_application_id: 'loan-1',
        trace_request: {
          loanApplicationId: 'loan-1',
          orderId: 'order-1'
        }
      }
    },
    {
      messageNumber: 1,
      message: {
        log_tag: 'FlipKart-CreateLoan_RESPONSE',
        trace_route: 'WRAPPER_APP',
        order_id: 'order-1',
        loan_application_id: 'loan-1',
        trace_response: {
          status: 'SUCCESS',
          loanApplicationId: 'loan-1'
        }
      }
    }
  ];

  const orchestrator = new AsyncReplayOrchestrator(logs, {
    timeoutMs: 10000,
    orderId: 'order-1'
  });

  const fallback = orchestrator.buildFailureFallbackResponse(
    {
      logTag: 'FlipKart-CreateLoan_REQUEST',
      logIndex: 0,
      requestId: 'live-request-1'
    },
    {
      status: 0,
      statusText: null,
      data: '',
      message: 'Request timeout'
    },
    {
      message: 'Request timeout'
    },
    null
  );

  assert.ok(fallback);
  assert.equal(fallback.reason, 'tolerated_batch_timeout_replay_response_fallback');
  assert.equal(fallback.postBatchConfirmationRequired, true);
  assert.equal(fallback.postBatchConfirmationResponseIndex, 1);
  assert.deepEqual(fallback.response.data, {
    status: 'SUCCESS',
    loanApplicationId: 'loan-1'
  });
});
