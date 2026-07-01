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

test('buildFailureFallbackResponse requires post-batch confirmation when no later FlipKart real-time eligibility request exists', () => {
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
  assert.equal(fallback.postBatchConfirmationRequired, true);
  assert.equal(orchestrator.pendingPostBatchConfirmations.has(1), true);
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
