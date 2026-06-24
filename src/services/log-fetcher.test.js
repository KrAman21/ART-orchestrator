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

test('filterOrchestratorSkippableLogs removes orphaned CORE->GATEWAY loan status requests without a fresh APP->CORE trigger', async () => {
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
