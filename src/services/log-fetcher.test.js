import test from 'node:test';
import assert from 'node:assert/strict';
import {
  compareLogsForReplay,
  filterAndSortLogs,
  filterOrchestratorSkippableLogs
} from './log-fetcher.js';

function buildLog({
  messageNumber,
  createdAt = '2026-06-19T10:00:00.000Z',
  logTag,
  traceRoute = 'LENDER_GATEWAY',
  requestId = 'req-1',
  payloadField = 'trace_request'
}) {
  return {
    messageNumber,
    message: {
      created_at: createdAt,
      log_tag: logTag,
      trace_route: traceRoute,
      request_id: requestId,
      [payloadField]: { ok: true }
    }
  };
}

test('compareLogsForReplay keeps chronological order for identical timestamps', () => {
  const logs = [
    buildLog({ messageNumber: 4, logTag: 'HDB_WEBHOOK_RESPONSE', payloadField: 'trace_response' }),
    buildLog({ messageNumber: 3, logTag: 'WEBHOOK_RESPONSE', payloadField: 'trace_response' }),
    buildLog({ messageNumber: 2, logTag: 'WEBHOOK_REQUEST' }),
    buildLog({ messageNumber: 1, logTag: 'HDB_WEBHOOK_REQUEST' })
  ];

  const sortedTags = [...logs].sort(compareLogsForReplay).map(log => log.message.log_tag);

  assert.deepEqual(sortedTags, [
    'HDB_WEBHOOK_REQUEST',
    'WEBHOOK_REQUEST',
    'WEBHOOK_RESPONSE',
    'HDB_WEBHOOK_RESPONSE'
  ]);
});

test('filterAndSortLogs applies the same timestamp tie-breaker before dedupe', async () => {
  const logs = [
    buildLog({ messageNumber: 4, logTag: 'HDB_WEBHOOK_RESPONSE', payloadField: 'trace_response' }),
    buildLog({ messageNumber: 3, logTag: 'WEBHOOK_RESPONSE', payloadField: 'trace_response' }),
    buildLog({ messageNumber: 2, logTag: 'WEBHOOK_REQUEST' }),
    buildLog({ messageNumber: 1, logTag: 'HDB_WEBHOOK_REQUEST' })
  ];

  const filtered = await filterAndSortLogs(logs);

  assert.deepEqual(filtered.map(log => log.message.log_tag), [
    'HDB_WEBHOOK_REQUEST',
    'WEBHOOK_REQUEST',
    'WEBHOOK_RESPONSE',
    'HDB_WEBHOOK_RESPONSE'
  ]);
});

test('filterAndSortLogs keeps LSP-GetAgreementDataStatus_REQUEST and normalizes missing trace_route to APP_CORE', async () => {
  const logs = [
    {
      messageNumber: 1,
      message: {
        created_at: '2026-06-29T10:00:00.000Z',
        log_tag: 'LSP-GetAgreementDataStatus_REQUEST',
        trace_route: null,
        label: 'APP',
        request_id: 'agreement-status-1',
        trace_request: null,
        trace_response: null,
        trace_error_msg: null,
        trace_request_ack: null,
        trace_response_ack: null
      }
    }
  ];

  const filtered = await filterAndSortLogs(logs);

  assert.equal(filtered.length, 1);
  assert.equal(filtered[0].message.log_tag, 'LSP-GetAgreementDataStatus_REQUEST');
  assert.equal(filtered[0].message.trace_route, 'APP_CORE');
});

test('filterAndSortLogs drops dotted log tags at first level', async () => {
  const logs = [
    {
      messageNumber: 1,
      message: {
        created_at: '2026-06-29T10:00:00.000Z',
        log_tag: 'TRANSACTION.READY_FOR_LOAN_CREATION',
        trace_route: 'CORE_APP',
        request_id: 'txn-ready-1',
        trace_response: {
          ok: true
        }
      }
    }
  ];

  const filtered = await filterAndSortLogs(logs);

  assert.equal(filtered.length, 0);
});

test('filterOrchestratorSkippableLogs keeps GATEWAY_LSP loan status async pair and drops redundant GATEWAY_CORE echo pair', async () => {
  const logs = [
    buildLog({
      messageNumber: 1,
      createdAt: '2026-06-23T11:53:42.594Z',
      logTag: 'LOAN_STATUS_ASYNC_RESPONSE_REQUEST',
      traceRoute: 'GATEWAY_LSP',
      requestId: 'loan-status-1'
    }),
    buildLog({
      messageNumber: 2,
      createdAt: '2026-06-23T11:53:43.590Z',
      logTag: 'LoanStatusResponse_REQUEST',
      traceRoute: 'GATEWAY_CORE',
      requestId: 'loan-status-1'
    }),
    buildLog({
      messageNumber: 3,
      createdAt: '2026-06-23T11:53:43.640Z',
      logTag: 'LoanStatusResponse_RESPONSE',
      traceRoute: 'GATEWAY_CORE',
      requestId: 'loan-status-1',
      payloadField: 'trace_response'
    }),
    buildLog({
      messageNumber: 4,
      createdAt: '2026-06-23T11:53:43.644Z',
      logTag: 'LOAN_STATUS_ASYNC_RESPONSE_RESPONSE',
      traceRoute: 'GATEWAY_LSP',
      requestId: 'loan-status-1',
      payloadField: 'trace_response'
    })
  ];

  const filtered = await filterOrchestratorSkippableLogs(logs);

  assert.deepEqual(
    filtered.map(log => [log.message.trace_route, log.message.log_tag]),
    [
      ['GATEWAY_LSP', 'LOAN_STATUS_ASYNC_RESPONSE_REQUEST'],
      ['GATEWAY_LSP', 'LOAN_STATUS_ASYNC_RESPONSE_RESPONSE']
    ]
  );
});

test('filterOrchestratorSkippableLogs reorders out-of-order UpdateKYC and KYC flow into request-then-kyc-pair-then-response order', async () => {
  const logs = [
    buildLog({
      messageNumber: 1,
      createdAt: '2026-06-24T09:00:00.000Z',
      logTag: 'KYC SERVICE API_REQUEST',
      traceRoute: 'GATEWAY_LENDER',
      requestId: 'kyc-req',
      payloadField: 'trace_request'
    }),
    buildLog({
      messageNumber: 2,
      createdAt: '2026-06-24T09:00:01.000Z',
      logTag: 'KYC SERVICE API_RESPONSE',
      traceRoute: 'LENDER_GATEWAY',
      requestId: 'kyc-res',
      payloadField: 'trace_response'
    }),
    {
      messageNumber: 3,
      message: {
        created_at: '2026-06-24T09:00:02.000Z',
        log_tag: 'UpdateKYCRequest-LSP_REQUEST',
        trace_route: 'CORE_GATEWAY',
        request_id: 'update-req',
        order_id: 'order-1',
        trace_request: {
          loanApplicationId: 'loan-1'
        }
      }
    },
    {
      messageNumber: 4,
      message: {
        created_at: '2026-06-24T09:00:03.000Z',
        log_tag: 'UpdateKYCRequest-LSP_RESPONSE',
        trace_route: 'GATEWAY_CORE',
        request_id: 'update-res',
        order_id: 'order-1',
        trace_response: {
          loanApplicationId: 'loan-1'
        }
      }
    }
  ].map(log => ({
    ...log,
    message: {
      ...log.message,
      order_id: log.message.order_id || 'order-1',
      loan_application_id: log.message.loan_application_id || 'loan-1'
    }
  }));

  const filtered = await filterOrchestratorSkippableLogs(logs);

  assert.deepEqual(
    filtered.map(log => log.message.log_tag),
    [
      'UpdateKYCRequest-LSP_REQUEST',
      'KYC SERVICE API_REQUEST',
      'KYC SERVICE API_RESPONSE',
      'UpdateKYCRequest-LSP_RESPONSE'
    ]
  );
});

test('filterOrchestratorSkippableLogs leaves correctly ordered UpdateKYC request, KYC pair, and UpdateKYC response unchanged', async () => {
  const logs = [
    buildLog({
      messageNumber: 1,
      createdAt: '2026-06-24T09:00:00.000Z',
      logTag: 'UpdateKYCRequest-LSP_REQUEST',
      traceRoute: 'CORE_GATEWAY',
      requestId: 'update-req'
    }),
    buildLog({
      messageNumber: 2,
      createdAt: '2026-06-24T09:00:01.000Z',
      logTag: 'KYC SERVICE API_REQUEST',
      traceRoute: 'GATEWAY_LENDER',
      requestId: 'kyc-req'
    }),
    buildLog({
      messageNumber: 3,
      createdAt: '2026-06-24T09:00:02.000Z',
      logTag: 'KYC SERVICE API_RESPONSE',
      traceRoute: 'LENDER_GATEWAY',
      requestId: 'kyc-res',
      payloadField: 'trace_response'
    }),
    buildLog({
      messageNumber: 4,
      createdAt: '2026-06-24T09:00:03.000Z',
      logTag: 'UpdateKYCRequest-LSP_RESPONSE',
      traceRoute: 'GATEWAY_CORE',
      requestId: 'update-res',
      payloadField: 'trace_response'
    })
  ].map(log => ({
    ...log,
    message: {
      ...log.message,
      order_id: 'order-1',
      loan_application_id: 'loan-1'
    }
  }));

  const filtered = await filterOrchestratorSkippableLogs(logs);

  assert.deepEqual(
    filtered.map(log => log.message.log_tag),
    [
      'UpdateKYCRequest-LSP_REQUEST',
      'KYC SERVICE API_REQUEST',
      'KYC SERVICE API_RESPONSE',
      'UpdateKYCRequest-LSP_RESPONSE'
    ]
  );
});

test('filterOrchestratorSkippableLogs synthesizes missing OTP generation request inside trigger-lender-otp block', async () => {
  const logs = [
    buildLog({
      messageNumber: 1,
      createdAt: '2026-06-29T11:28:41.382Z',
      logTag: 'TriggerLenderOTPRequest_REQUEST',
      traceRoute: 'APP_CORE',
      requestId: 'app-trigger-req'
    }),
    buildLog({
      messageNumber: 2,
      createdAt: '2026-06-29T11:28:41.408Z',
      logTag: 'TriggerLenderOTPRequest_RESPONSE',
      traceRoute: 'APP_CORE',
      requestId: 'app-trigger-res',
      payloadField: 'trace_response'
    }),
    {
      messageNumber: 3,
      message: {
        created_at: '2026-06-29T11:28:41.421Z',
        log_tag: 'TriggerLenderOTPRequest-LSP_REQUEST',
        trace_route: 'CORE_GATEWAY',
        request_id: 'core-trigger-req',
        order_id: 'order-1',
        loan_application_id: 'loan-1',
        trace_request: {
          loanApplicationId: 'loan-1'
        }
      }
    },
    buildLog({
      messageNumber: 4,
      createdAt: '2026-06-29T11:28:41.432Z',
      logTag: 'FECTH_LOAN_APPLICATION_DATA_API_REQUEST',
      traceRoute: 'GATEWAY_LSP',
      requestId: 'fetch-loan-app-req'
    }),
    buildLog({
      messageNumber: 5,
      createdAt: '2026-06-29T11:28:41.454Z',
      logTag: 'FECTH_LOAN_APPLICATION_DATA_API_RESPONSE',
      traceRoute: 'LSP_GATEWAY',
      requestId: 'fetch-loan-app-res',
      payloadField: 'trace_response'
    }),
    {
      messageNumber: 6,
      message: {
        created_at: '2026-06-29T11:28:41.807Z',
        log_tag: 'OTP GENERATION API_RESPONSE',
        trace_route: 'LENDER_GATEWAY',
        request_id: 'otp-res',
        order_id: 'order-1',
        loan_application_id: 'loan-1',
        trace_response: {
          success: true
        }
      }
    },
    {
      messageNumber: 7,
      message: {
        created_at: '2026-06-29T11:28:41.821Z',
        log_tag: 'TriggerLenderOTPRequest-LSP_RESPONSE',
        trace_route: 'CORE_GATEWAY',
        request_id: 'core-trigger-res',
        order_id: 'order-1',
        loan_application_id: 'loan-1',
        trace_response_ack: {
          success: true
        }
      }
    }
  ];

  const filtered = await filterOrchestratorSkippableLogs(logs);

  assert.deepEqual(
    filtered.map(log => log.message.log_tag),
    [
      'TriggerLenderOTPRequest_REQUEST',
      'TriggerLenderOTPRequest_RESPONSE',
      'TriggerLenderOTPRequest-LSP_REQUEST',
      'FECTH_LOAN_APPLICATION_DATA_API_REQUEST',
      'FECTH_LOAN_APPLICATION_DATA_API_RESPONSE',
      'OTP GENERATION API_REQUEST',
      'OTP GENERATION API_RESPONSE',
      'TriggerLenderOTPRequest-LSP_RESPONSE'
    ]
  );
});

test('filterOrchestratorSkippableLogs synthesizes missing OTP authentication request inside verify-lender-otp block', async () => {
  const logs = [
    buildLog({
      messageNumber: 1,
      createdAt: '2026-06-29T19:00:57.900Z',
      logTag: 'VerifyLenderOTP_REQUEST',
      traceRoute: 'APP_CORE',
      requestId: 'app-verify-req',
      loanApplicationId: 'loan-1'
    }),
    buildLog({
      messageNumber: 2,
      createdAt: '2026-06-29T19:00:57.950Z',
      logTag: 'VerifyLenderOTP_RESPONSE',
      traceRoute: 'APP_CORE',
      requestId: 'app-verify-res',
      payloadField: 'trace_response',
      loanApplicationId: 'loan-1'
    }),
    {
      messageNumber: 3,
      message: {
        created_at: '2026-06-29T19:00:58.000Z',
        log_tag: 'VerifyLenderOTPRequest-LSP_REQUEST',
        trace_route: 'CORE_GATEWAY',
        request_id: 'core-verify-req',
        order_id: 'order-1',
        loan_application_id: 'loan-1',
        trace_request: {
          loanApplicationId: 'loan-1'
        }
      }
    },
    {
      messageNumber: 4,
      message: {
        created_at: '2026-06-29T19:00:58.249Z',
        log_tag: 'OTP AUTHENTICATION API_RESPONSE',
        trace_route: 'GATEWAY_LENDER',
        request_id: 'otp-auth-res',
        order_id: 'order-1',
        loan_application_id: 'loan-1',
        trace_response: {
          success: true
        }
      }
    },
    {
      messageNumber: 5,
      message: {
        created_at: '2026-06-29T19:00:58.300Z',
        log_tag: 'VerifyLenderOTPRequest-LSP_RESPONSE',
        trace_route: 'CORE_GATEWAY',
        request_id: 'core-verify-res',
        order_id: 'order-1',
        loan_application_id: 'loan-1',
        trace_response_ack: {
          success: true
        }
      }
    }
  ];

  const filtered = await filterOrchestratorSkippableLogs(logs);

  assert.deepEqual(
    filtered.map(log => log.message.log_tag),
    [
      'VerifyLenderOTP_REQUEST',
      'VerifyLenderOTP_RESPONSE',
      'VerifyLenderOTPRequest-LSP_REQUEST',
      'OTP AUTHENTICATION API_REQUEST',
      'OTP AUTHENTICATION API_RESPONSE',
      'VerifyLenderOTPRequest-LSP_RESPONSE'
    ]
  );
});

test('filterOrchestratorSkippableLogs synthesizes missing generic gateway-lender request when only response survives filtering', async () => {
  const logs = [
    {
      messageNumber: 1,
      message: {
        created_at: '2026-06-29T19:01:00.000Z',
        log_tag: 'CHECK ELIGIBILITY API_RESPONSE',
        trace_route: 'GATEWAY_LENDER',
        request_id: 'eligibility-res',
        order_id: 'order-1',
        loan_application_id: 'loan-1',
        trace_response: {
          success: true
        }
      }
    }
  ];

  const filtered = await filterOrchestratorSkippableLogs(logs);

  assert.deepEqual(
    filtered.map(log => [log.message.trace_route, log.message.log_tag]),
    [
      ['GATEWAY_LENDER', 'CHECK ELIGIBILITY API_REQUEST'],
      ['GATEWAY_LENDER', 'CHECK ELIGIBILITY API_RESPONSE']
    ]
  );
});

test('filterOrchestratorSkippableLogs removes order-status pair that appears before FlipKart-FetchStatus trigger in same order context', async () => {
  const logs = [
    {
      messageNumber: 1,
      message: {
        created_at: '2026-06-25T11:20:09.779Z',
        log_tag: 'ORDER_STATUS_API_LS_REQUEST',
        trace_route: 'GATEWAY_LENDER',
        request_id: 'order-status-early-req',
        merchant_id: 'flipkartSM',
        loan_application_id: 'loan-1',
        trace_request: {
          merchant_order_placement_id: 'OD4379241627771351',
          merchant_order_id: 'PZT26062516499XLEN01'
        }
      }
    },
    {
      messageNumber: 2,
      message: {
        created_at: '2026-06-25T11:20:09.933Z',
        log_tag: 'ORDER_STATUS_API_LS_RESPONSE',
        trace_route: 'LENDER_GATEWAY',
        request_id: 'order-status-early-res',
        merchant_id: 'flipkartSM',
        loan_application_id: 'loan-1',
        trace_response: {
          order_status: 'IN_PROGRESS'
        },
        trace_request: {
          merchant_order_placement_id: 'OD4379241627771351',
          merchant_order_id: 'PZT26062516499XLEN01'
        }
      }
    },
    {
      messageNumber: 3,
      message: {
        created_at: '2026-06-25T11:21:48.885Z',
        log_tag: 'FlipKart-FetchStatus_REQUEST',
        trace_route: 'APP_WRAPPER',
        request_id: 'fetch-status-1',
        merchant_id: 'flipkartSM',
        order_id: 'OD4379241627771351',
        trace_request: {
          order_id: 'OD4379241627771351',
          txn_id: 'PZT26062516499XLEN01'
        }
      }
    },
    {
      messageNumber: 4,
      message: {
        created_at: '2026-06-25T11:21:48.901Z',
        log_tag: 'FlipKart-FetchStatus_RESPONSE',
        trace_route: 'APP_WRAPPER',
        request_id: 'fetch-status-1-res',
        merchant_id: 'flipkartSM',
        order_id: 'OD4379241627771351',
        trace_response: {
          order_status: 'PENDING'
        }
      }
    },
    {
      messageNumber: 5,
      message: {
        created_at: '2026-06-25T11:21:48.997Z',
        log_tag: 'ORDER_STATUS_API_LS_REQUEST',
        trace_route: 'GATEWAY_LENDER',
        request_id: 'order-status-late-req',
        merchant_id: 'flipkartSM',
        loan_application_id: 'loan-1',
        order_id: 'OD4379241627771351',
        trace_request: {
          merchant_order_placement_id: 'OD4379241627771351',
          merchant_order_id: 'PZT26062516499XLEN01'
        }
      }
    },
    {
      messageNumber: 6,
      message: {
        created_at: '2026-06-25T11:21:49.095Z',
        log_tag: 'ORDER_STATUS_API_LS_RESPONSE',
        trace_route: 'LENDER_GATEWAY',
        request_id: 'order-status-late-res',
        merchant_id: 'flipkartSM',
        loan_application_id: 'loan-1',
        order_id: 'OD4379241627771351',
        trace_response: {
          order_status: 'SUCCESS'
        }
      }
    }
  ];

  const filtered = await filterOrchestratorSkippableLogs(logs);

  assert.deepEqual(
    filtered.map(log => log.message.log_tag),
    [
      'FlipKart-FetchStatus_REQUEST',
      'FlipKart-FetchStatus_RESPONSE',
      'ORDER_STATUS_API_LS_REQUEST',
      'ORDER_STATUS_API_LS_RESPONSE'
    ]
  );
});

test('filterOrchestratorSkippableLogs keeps CORE->GATEWAY loan status request when fetch-status flow already triggered the same order context', async () => {
  const logs = [
    {
      messageNumber: 1,
      message: {
        created_at: '2026-06-25T11:21:48.885Z',
        log_tag: 'FlipKart-FetchStatus_REQUEST',
        trace_route: 'APP_WRAPPER',
        request_id: 'fetch-status-1',
        merchant_id: 'flipkartSM',
        order_id: 'OD4379241627771351',
        trace_request: {
          order_id: 'OD4379241627771351',
          txn_id: 'PZT26062516499XLEN01'
        }
      }
    },
    {
      messageNumber: 2,
      message: {
        created_at: '2026-06-25T11:21:48.901Z',
        log_tag: 'FlipKart-FetchStatus_RESPONSE',
        trace_route: 'APP_WRAPPER',
        request_id: 'fetch-status-1-res',
        merchant_id: 'flipkartSM',
        order_id: 'OD4379241627771351',
        trace_response: {
          order_status: 'PENDING'
        }
      }
    },
    {
      messageNumber: 3,
      message: {
        created_at: '2026-06-25T11:21:48.997Z',
        log_tag: 'ORDER_STATUS_API_LS_REQUEST',
        trace_route: 'GATEWAY_LENDER',
        request_id: 'order-status-req',
        merchant_id: 'flipkartSM',
        loan_application_id: 'loan-1',
        order_id: 'OD4379241627771351',
        trace_request: {
          merchant_order_placement_id: 'OD4379241627771351',
          merchant_order_id: 'PZT26062516499XLEN01'
        }
      }
    },
    {
      messageNumber: 4,
      message: {
        created_at: '2026-06-25T11:21:49.095Z',
        log_tag: 'ORDER_STATUS_API_LS_RESPONSE',
        trace_route: 'LENDER_GATEWAY',
        request_id: 'order-status-res',
        merchant_id: 'flipkartSM',
        loan_application_id: 'loan-1',
        order_id: 'OD4379241627771351',
        trace_response: {
          order_status: 'SUCCESS'
        }
      }
    },
    {
      messageNumber: 5,
      message: {
        created_at: '2026-06-25T11:21:49.185Z',
        log_tag: 'Lsp-LoanStatusRequest_REQUEST',
        trace_route: 'CORE_GATEWAY',
        request_id: 'core-gateway-1',
        merchant_id: 'flipkartSM',
        loan_application_id: 'loan-1',
        order_id: 'OD4379241627771351',
        trace_request: {
          forwardTxnId: 'PZT26062516499XLEN01',
          loanApplicationId: 'loan-1'
        }
      }
    },
    {
      messageNumber: 6,
      message: {
        created_at: '2026-06-25T11:21:49.285Z',
        log_tag: 'Lsp-LoanStatusRequest_RESPONSE',
        trace_route: 'GATEWAY_CORE',
        request_id: 'core-gateway-1',
        merchant_id: 'flipkartSM',
        loan_application_id: 'loan-1',
        order_id: 'OD4379241627771351',
        trace_response: {
          orderStatus: 'SUCCESS'
        }
      }
    }
  ];

  const filtered = await filterOrchestratorSkippableLogs(logs);

  assert.deepEqual(
    filtered.map(log => log.message.log_tag),
    [
      'FlipKart-FetchStatus_REQUEST',
      'FlipKart-FetchStatus_RESPONSE',
      'ORDER_STATUS_API_LS_REQUEST',
      'ORDER_STATUS_API_LS_RESPONSE',
      'Lsp-LoanStatusRequest_REQUEST',
      'Lsp-LoanStatusRequest_RESPONSE'
    ]
  );
});

test('filterOrchestratorSkippableLogs forcibly reorders flipkartSM fetch-status progression when raw sort order is wrong', async () => {
  const logs = [
    {
      messageNumber: 1,
      message: {
        created_at: '2026-06-25T11:21:48.885Z',
        log_tag: 'FlipKart-FetchStatus_REQUEST',
        trace_route: 'APP_WRAPPER',
        request_id: 'fetch-status-1',
        merchant_id: 'flipkartSM',
        order_id: 'OD4379241627771351',
        trace_request: {
          order_id: 'OD4379241627771351',
          txn_id: 'PZT26062516499XLEN01'
        }
      }
    },
    {
      messageNumber: 2,
      message: {
        created_at: '2026-06-25T11:21:48.901Z',
        log_tag: 'FlipKart-FetchStatus_RESPONSE',
        trace_route: 'APP_WRAPPER',
        request_id: 'fetch-status-1-res',
        merchant_id: 'flipkartSM',
        order_id: 'OD4379241627771351',
        trace_response: {
          order_status: 'PENDING'
        }
      }
    },
    {
      messageNumber: 3,
      message: {
        created_at: '2026-06-25T11:21:48.997Z',
        log_tag: 'ORDER_STATUS_API_LS_REQUEST',
        trace_route: 'GATEWAY_LENDER',
        request_id: 'order-status-req',
        merchant_id: 'flipkartSM',
        loan_application_id: 'loan-1',
        order_id: 'OD4379241627771351',
        trace_request: {
          merchant_order_placement_id: 'OD4379241627771351',
          merchant_order_id: 'PZT26062516499XLEN01'
        }
      }
    },
    {
      messageNumber: 4,
      message: {
        created_at: '2026-06-25T11:21:49.020Z',
        log_tag: 'ORDER_STATUS_API_LS_RESPONSE',
        trace_route: 'LENDER_GATEWAY',
        request_id: 'order-status-res',
        merchant_id: 'flipkartSM',
        loan_application_id: 'loan-1',
        order_id: 'OD4379241627771351',
        trace_response: {
          order_status: 'SUCCESS'
        }
      }
    },
    {
      messageNumber: 5,
      message: {
        created_at: '2026-06-25T11:21:49.101Z',
        log_tag: 'FECTH_LOAN_APPLICATION_DATA_API_REQUEST',
        trace_route: 'GATEWAY_LSP',
        request_id: 'fetch-la-req',
        merchant_id: 'flipkartSM',
        loan_application_id: 'loan-1',
        order_id: 'OD4379241627771351',
        trace_request: {
          loanApplicationId: 'loan-1',
          order_id: 'OD4379241627771351'
        }
      }
    },
    {
      messageNumber: 6,
      message: {
        created_at: '2026-06-25T11:21:49.120Z',
        log_tag: 'FECTH_LOAN_APPLICATION_DATA_API_RESPONSE',
        trace_route: 'GATEWAY_LSP',
        request_id: 'fetch-la-res',
        merchant_id: 'flipkartSM',
        loan_application_id: 'loan-1',
        order_id: 'OD4379241627771351',
        trace_response: {
          loanApplicationId: 'loan-1'
        }
      }
    },
    {
      messageNumber: 7,
      message: {
        created_at: '2026-06-25T11:21:49.152Z',
        log_tag: 'LOAN_STATUS_ASYNC_RESPONSE_REQUEST',
        trace_route: 'GATEWAY_LSP',
        request_id: 'loan-status-async-req',
        merchant_id: 'flipkartSM',
        loan_application_id: 'loan-1',
        order_id: 'OD4379241627771351',
        trace_request: {
          loanDetails: {
            loanApplicationId: 'loan-1'
          },
          merchant_order_id: 'PZT26062516499XLEN01'
        }
      }
    },
    {
      messageNumber: 8,
      message: {
        created_at: '2026-06-25T11:21:49.170Z',
        log_tag: 'LOAN_STATUS_ASYNC_RESPONSE_RESPONSE',
        trace_route: 'GATEWAY_LSP',
        request_id: 'loan-status-async-res',
        merchant_id: 'flipkartSM',
        loan_application_id: 'loan-1',
        order_id: 'OD4379241627771351',
        trace_response: {
          ack: {
            error: '0'
          }
        }
      }
    },
    {
      messageNumber: 9,
      message: {
        created_at: '2026-06-25T11:21:49.185Z',
        log_tag: 'Lsp-LoanStatusRequest_REQUEST',
        trace_route: 'CORE_GATEWAY',
        request_id: 'core-gateway-1',
        merchant_id: 'flipkartSM',
        loan_application_id: 'loan-1',
        order_id: 'OD4379241627771351',
        trace_request: {
          forwardTxnId: 'PZT26062516499XLEN01',
          loanApplicationId: 'loan-1'
        }
      }
    },
    {
      messageNumber: 10,
      message: {
        created_at: '2026-06-25T11:21:49.200Z',
        log_tag: 'Lsp-LoanStatusRequest_RESPONSE',
        trace_route: 'GATEWAY_CORE',
        request_id: 'core-gateway-1',
        merchant_id: 'flipkartSM',
        loan_application_id: 'loan-1',
        order_id: 'OD4379241627771351',
        trace_response: {
          orderStatus: 'SUCCESS'
        }
      }
    }
  ];

  const filtered = await filterOrchestratorSkippableLogs(logs);

  const tags = filtered.map(log => log.message.log_tag);
  const flipKartFetchStatusIndex = tags.indexOf('FlipKart-FetchStatus_REQUEST');
  const coreGatewayLoanStatusIndex = tags.indexOf('Lsp-LoanStatusRequest_REQUEST');
  const orderStatusIndex = tags.indexOf('ORDER_STATUS_API_LS_REQUEST');
  const fetchLoanApplicationIndex = tags.indexOf('FECTH_LOAN_APPLICATION_DATA_API_REQUEST');
  const loanStatusAsyncIndex = tags.indexOf('LOAN_STATUS_ASYNC_RESPONSE_REQUEST');

  assert.notEqual(flipKartFetchStatusIndex, -1);
  assert.notEqual(coreGatewayLoanStatusIndex, -1);
  assert.notEqual(orderStatusIndex, -1);
  assert.notEqual(fetchLoanApplicationIndex, -1);
  assert.notEqual(loanStatusAsyncIndex, -1);

  assert.ok(coreGatewayLoanStatusIndex > flipKartFetchStatusIndex);
  assert.ok(orderStatusIndex > coreGatewayLoanStatusIndex);
  assert.ok(fetchLoanApplicationIndex > orderStatusIndex);
  assert.ok(loanStatusAsyncIndex > fetchLoanApplicationIndex);
});

test('filterOrchestratorSkippableLogs does not filter out CORE->GATEWAY loan status requests directly', async () => {
  const logs = [
    buildLog({
      messageNumber: 1,
      createdAt: '2026-06-24T09:00:00.000Z',
      logTag: 'LSP-LoanStatus_REQUEST',
      traceRoute: 'APP_CORE',
      requestId: 'app-core-1'
    }),
    buildLog({
      messageNumber: 2,
      createdAt: '2026-06-24T09:00:00.500Z',
      logTag: 'LSP-LoanStatus_RESPONSE',
      traceRoute: 'CORE_APP',
      requestId: 'app-core-1',
      payloadField: 'trace_response'
    }),
    buildLog({
      messageNumber: 3,
      createdAt: '2026-06-24T09:00:01.000Z',
      logTag: 'Lsp-LoanStatusRequest_REQUEST',
      traceRoute: 'CORE_GATEWAY',
      requestId: 'core-gateway-1'
    }),
    buildLog({
      messageNumber: 4,
      createdAt: '2026-06-24T09:00:02.000Z',
      logTag: 'Lsp-LoanStatusRequest_RESPONSE',
      traceRoute: 'GATEWAY_CORE',
      requestId: 'core-gateway-1',
      payloadField: 'trace_response'
    }),
    buildLog({
      messageNumber: 5,
      createdAt: '2026-06-24T09:00:03.000Z',
      logTag: 'Lsp-LoanStatusRequest_REQUEST',
      traceRoute: 'CORE_GATEWAY',
      requestId: 'core-gateway-2'
    }),
    buildLog({
      messageNumber: 6,
      createdAt: '2026-06-24T09:00:04.000Z',
      logTag: 'Lsp-LoanStatusRequest_RESPONSE',
      traceRoute: 'GATEWAY_CORE',
      requestId: 'core-gateway-2',
      payloadField: 'trace_response'
    })
  ].map(log => ({
    ...log,
    message: {
      ...log.message,
      order_id: log.message.request_id === 'core-gateway-2' ? 'order-2' : 'order-1',
      loan_application_id: log.message.request_id === 'core-gateway-2' ? 'loan-2' : 'loan-1'
    }
  }));

  const filtered = await filterOrchestratorSkippableLogs(logs);

  assert.deepEqual(
    filtered.map(log => [log.message.trace_route, log.message.log_tag]),
    [
      ['APP_CORE', 'LSP-LoanStatus_REQUEST'],
      ['CORE_APP', 'LSP-LoanStatus_RESPONSE'],
      ['CORE_GATEWAY', 'Lsp-LoanStatusRequest_REQUEST'],
      ['GATEWAY_CORE', 'Lsp-LoanStatusRequest_RESPONSE'],
      ['CORE_GATEWAY', 'Lsp-LoanStatusRequest_REQUEST'],
      ['GATEWAY_CORE', 'Lsp-LoanStatusRequest_RESPONSE']
    ]
  );
});

test('filterOrchestratorSkippableLogs keeps extra APP->CORE loan status triggers and only consumes one per CORE->GATEWAY request', async () => {
  const logs = [
    buildLog({
      messageNumber: 1,
      createdAt: '2026-06-24T09:00:00.000Z',
      logTag: 'LSP-LoanStatus_REQUEST',
      traceRoute: 'APP_CORE',
      requestId: 'app-core-1'
    }),
    buildLog({
      messageNumber: 2,
      createdAt: '2026-06-24T09:00:00.300Z',
      logTag: 'LSP-LoanStatus_RESPONSE',
      traceRoute: 'CORE_APP',
      requestId: 'app-core-1',
      payloadField: 'trace_response'
    }),
    buildLog({
      messageNumber: 3,
      createdAt: '2026-06-24T09:00:01.000Z',
      logTag: 'LSP-LoanStatus_REQUEST',
      traceRoute: 'APP_CORE',
      requestId: 'app-core-2'
    }),
    buildLog({
      messageNumber: 4,
      createdAt: '2026-06-24T09:00:01.300Z',
      logTag: 'LSP-LoanStatus_RESPONSE',
      traceRoute: 'CORE_APP',
      requestId: 'app-core-2',
      payloadField: 'trace_response'
    }),
    buildLog({
      messageNumber: 5,
      createdAt: '2026-06-24T09:00:02.000Z',
      logTag: 'Lsp-LoanStatusRequest_REQUEST',
      traceRoute: 'CORE_GATEWAY',
      requestId: 'core-gateway-1'
    }),
    buildLog({
      messageNumber: 6,
      createdAt: '2026-06-24T09:00:03.000Z',
      logTag: 'Lsp-LoanStatusRequest_RESPONSE',
      traceRoute: 'GATEWAY_CORE',
      requestId: 'core-gateway-1',
      payloadField: 'trace_response'
    }),
    buildLog({
      messageNumber: 7,
      createdAt: '2026-06-24T09:00:04.000Z',
      logTag: 'LSP-LoanStatus_REQUEST',
      traceRoute: 'APP_CORE',
      requestId: 'app-core-3'
    }),
    buildLog({
      messageNumber: 8,
      createdAt: '2026-06-24T09:00:04.300Z',
      logTag: 'LSP-LoanStatus_RESPONSE',
      traceRoute: 'CORE_APP',
      requestId: 'app-core-3',
      payloadField: 'trace_response'
    }),
    buildLog({
      messageNumber: 9,
      createdAt: '2026-06-24T09:00:05.000Z',
      logTag: 'Lsp-LoanStatusRequest_REQUEST',
      traceRoute: 'CORE_GATEWAY',
      requestId: 'core-gateway-2'
    }),
    buildLog({
      messageNumber: 10,
      createdAt: '2026-06-24T09:00:06.000Z',
      logTag: 'Lsp-LoanStatusRequest_RESPONSE',
      traceRoute: 'GATEWAY_CORE',
      requestId: 'core-gateway-2',
      payloadField: 'trace_response'
    })
  ].map(log => ({
    ...log,
    message: {
      ...log.message,
      order_id: 'order-1',
      loan_application_id: 'loan-1'
    }
  }));

  const filtered = await filterOrchestratorSkippableLogs(logs);

  assert.deepEqual(
    filtered.map(log => [log.message.trace_route, log.message.log_tag]),
    [
      ['APP_CORE', 'LSP-LoanStatus_REQUEST'],
      ['CORE_APP', 'LSP-LoanStatus_RESPONSE'],
      ['APP_CORE', 'LSP-LoanStatus_REQUEST'],
      ['CORE_APP', 'LSP-LoanStatus_RESPONSE'],
      ['CORE_GATEWAY', 'Lsp-LoanStatusRequest_REQUEST'],
      ['GATEWAY_CORE', 'Lsp-LoanStatusRequest_RESPONSE'],
      ['APP_CORE', 'LSP-LoanStatus_REQUEST'],
      ['CORE_APP', 'LSP-LoanStatus_RESPONSE'],
      ['CORE_GATEWAY', 'Lsp-LoanStatusRequest_REQUEST'],
      ['GATEWAY_CORE', 'Lsp-LoanStatusRequest_RESPONSE']
    ]
  );
});

test('filterOrchestratorSkippableLogs keeps only HDB lender loan-status flow backed by kept CORE->GATEWAY trigger', async () => {
  const logs = [
    {
      messageNumber: 0,
      message: {
        created_at: '2026-06-27T11:44:52.200Z',
        log_tag: 'FlipKart-FetchStatus_REQUEST',
        trace_route: 'APP_WRAPPER',
        request_id: 'fetch-status-1',
        merchant_id: 'flipkart',
        order_id: 'order-1',
        trace_request: {
          order_id: 'order-1',
          txn_id: 'txn-1'
        }
      }
    },
    {
      messageNumber: 1,
      message: {
        created_at: '2026-06-27T11:44:52.313Z',
        log_tag: 'Lsp-LoanStatusRequest_REQUEST',
        trace_route: 'CORE_GATEWAY',
        request_id: 'core-gateway-1',
        order_id: 'order-1',
        loan_application_id: 'loan-1',
        lender_org_id: 'HDB',
        trace_request: {
          loanApplicationId: 'loan-1',
          forwardTxnId: 'txn-1'
        }
      }
    },
    {
      messageNumber: 2,
      message: {
        created_at: '2026-06-27T11:44:52.352Z',
        log_tag: 'HDB_APPLICATION_STATUS_API :: LOAN_STATUS_REQUEST',
        trace_route: 'GATEWAY_LENDER',
        request_id: 'hdb-req-1',
        order_id: 'order-1',
        loan_application_id: 'loan-1',
        lender_org_id: 'HDB',
        trace_request: {
          data: { applicationId: 'HF-1' }
        }
      }
    },
    {
      messageNumber: 3,
      message: {
        created_at: '2026-06-27T11:44:52.598Z',
        log_tag: 'HDB_APPLICATION_STATUS_API :: LOAN_STATUS_RESPONSE',
        trace_route: 'GATEWAY_LENDER',
        request_id: 'hdb-res-1',
        order_id: 'order-1',
        loan_application_id: 'loan-1',
        lender_org_id: 'HDB',
        trace_response: {
          partnerRefNo: 'loan-1'
        }
      }
    },
    {
      messageNumber: 4,
      message: {
        created_at: '2026-06-27T11:44:52.621Z',
        log_tag: 'LOAN_STATUS_ASYNC_RESPONSE_REQUEST',
        trace_route: 'GATEWAY_LSP',
        request_id: 'async-req-1',
        order_id: 'order-1',
        loan_application_id: 'loan-1',
        lender_org_id: 'HDB',
        trace_request: {
          loanDetails: { loanApplicationId: 'loan-1' }
        }
      }
    },
    {
      messageNumber: 5,
      message: {
        created_at: '2026-06-27T11:44:52.640Z',
        log_tag: 'LOAN_STATUS_ASYNC_RESPONSE_RESPONSE',
        trace_route: 'GATEWAY_LSP',
        request_id: 'async-res-1',
        order_id: 'order-1',
        loan_application_id: 'loan-1',
        lender_org_id: 'HDB',
        trace_response: {
          ack: { error: '0' }
        }
      }
    },
    {
      messageNumber: 6,
      message: {
        created_at: '2026-06-27T11:46:15.293Z',
        log_tag: 'HDB_APPLICATION_STATUS_API :: LOAN_STATUS_REQUEST',
        trace_route: 'GATEWAY_LENDER',
        request_id: 'hdb-req-2',
        loan_application_id: 'loan-1',
        lender_org_id: 'HDB',
        trace_request: {
          data: { applicationId: 'HF-1' }
        }
      }
    },
    {
      messageNumber: 7,
      message: {
        created_at: '2026-06-27T11:46:15.510Z',
        log_tag: 'HDB_APPLICATION_STATUS_API :: LOAN_STATUS_RESPONSE',
        trace_route: 'GATEWAY_LENDER',
        request_id: 'hdb-res-2',
        loan_application_id: 'loan-1',
        lender_org_id: 'HDB',
        trace_response: {
          partnerRefNo: 'loan-1'
        }
      }
    },
    {
      messageNumber: 8,
      message: {
        created_at: '2026-06-27T11:46:15.526Z',
        log_tag: 'LOAN_STATUS_ASYNC_RESPONSE_REQUEST',
        trace_route: 'GATEWAY_LSP',
        request_id: 'async-req-2',
        loan_application_id: 'loan-1',
        lender_org_id: 'HDB',
        trace_request: {
          loanDetails: { loanApplicationId: 'loan-1' }
        }
      }
    },
    {
      messageNumber: 9,
      message: {
        created_at: '2026-06-27T11:46:15.540Z',
        log_tag: 'LOAN_STATUS_ASYNC_RESPONSE_RESPONSE',
        trace_route: 'GATEWAY_LSP',
        request_id: 'async-res-2',
        loan_application_id: 'loan-1',
        lender_org_id: 'HDB',
        trace_response: {
          ack: { error: '0' }
        }
      }
    }
  ];

  const filtered = await filterOrchestratorSkippableLogs(logs);

  assert.deepEqual(
    filtered.map(log => log.message.log_tag),
    [
      'HDB_APPLICATION_STATUS_API :: LOAN_STATUS_REQUEST',
      'HDB_APPLICATION_STATUS_API :: LOAN_STATUS_RESPONSE',
      'LOAN_STATUS_ASYNC_RESPONSE_REQUEST',
      'LOAN_STATUS_ASYNC_RESPONSE_RESPONSE'
    ]
  );
});
