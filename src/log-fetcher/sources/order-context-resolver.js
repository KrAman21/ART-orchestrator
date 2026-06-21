import { logger } from '../../utils/logger.js';
import { SERVICE_MAP } from '../../config.js';
import { makeRequest } from '../../services/http-client.js';

const DEFAULT_ORDER_CONTEXT_ENDPOINT = process.env.LSP_ORDER_CONTEXT_ENDPOINT || '/art/order-context/fetch';

function pushCandidate(target, value) {
  if (typeof value !== 'string') {
    return;
  }

  const normalized = value.trim();
  if (!normalized) {
    return;
  }

  target.push(normalized);
}

function scanValueForContext(value, bucket) {
  if (Array.isArray(value)) {
    value.forEach(item => scanValueForContext(item, bucket));
    return;
  }

  if (!value || typeof value !== 'object') {
    return;
  }

  for (const [key, nestedValue] of Object.entries(value)) {
    if (key === 'customerId' || key === 'customer_id' || key === 'merchant_customer_id' || key === 'merchantCustomerId') {
      pushCandidate(bucket.customerIds, nestedValue);
    }

    if (key === 'loanApplicationId' || key === 'loan_application_id') {
      pushCandidate(bucket.loanApplicationIds, nestedValue);
    }

    if (key === 'laid' || key === 'laId' || key === 'la_id') {
      pushCandidate(bucket.loanApplicationIds, nestedValue);
    }

    scanValueForContext(nestedValue, bucket);
  }
}

function uniqueStrings(values) {
  return [...new Set(values.filter(Boolean))];
}

export function extractReplayContextFromLogs(logs = []) {
  const bucket = {
    customerIds: [],
    loanApplicationIds: []
  };

  for (const log of logs) {
    scanValueForContext(log, bucket);
  }

  return {
    customerId: uniqueStrings(bucket.customerIds)[0] || null,
    loanApplicationIds: uniqueStrings(bucket.loanApplicationIds)
  };
}

function normalizeLspResponse(data) {
  const payload = data?.response ?? data ?? {};
  const customerId = typeof payload.customerId === 'string' ? payload.customerId.trim() : '';
  const directLoanApplicationId = typeof payload.loanApplicationId === 'string' ? payload.loanApplicationId.trim() : '';
  const listedLoanApplicationIds = Array.isArray(payload.loanApplicationIds)
    ? payload.loanApplicationIds
      .filter(value => typeof value === 'string')
      .map(value => value.trim())
      .filter(Boolean)
    : [];
  const loanApplicationIds = [...new Set([
    ...listedLoanApplicationIds,
    ...(directLoanApplicationId ? [directLoanApplicationId] : [])
  ])];

  return {
    customerId: customerId || null,
    loanApplicationIds
  };
}

export async function resolveOrderContextFromLsp(merchantId, orderId, options = {}) {
  const serviceConfig = SERVICE_MAP?.LSP || {};
  const baseUrl = options.baseUrl || serviceConfig.baseUrl || 'http://127.0.0.1:8080';
  const endpoint = options.endpoint || DEFAULT_ORDER_CONTEXT_ENDPOINT;
  const unixSocket = options.unixSocket || serviceConfig.unixSocket || null;

  try {
    logger.info('Resolving order context from local LSP proxy endpoint', {
      merchantId,
      orderId,
      endpoint,
      hasUnixSocket: Boolean(unixSocket)
    });

    const response = await makeRequest(
      baseUrl,
      endpoint,
      'POST',
      { merchantId, orderId },
      null,
      'ART_LSP',
      'ART-OrderContextLookup',
      merchantId,
      {},
      null,
      unixSocket,
      options.timeoutMs || 15000
    );

    if (response?.error) {
      return {
        success: false,
        customerId: null,
        loanApplicationIds: [],
        error: response.message || 'LSP order-context lookup failed'
      };
    }

    if (response?.status < 200 || response?.status >= 300) {
      logger.warn('LSP order-context lookup returned non-success status', {
        merchantId,
        orderId,
        endpoint,
        status: response?.status,
        response: response?.data
      });

      return {
        success: false,
        customerId: null,
        loanApplicationIds: [],
        error: `HTTP error! status: ${response?.status || 0}`
      };
    }

    const normalized = normalizeLspResponse(response.data);

    logger.info('Resolved order context from local LSP proxy endpoint', {
      merchantId,
      orderId,
      customerId: normalized.customerId,
      loanApplicationIds: normalized.loanApplicationIds
    });

    return {
      success: true,
      ...normalized,
      raw: response.data
    };
  } catch (error) {
    logger.warn('LSP order-context lookup exception', {
      merchantId,
      orderId,
      error: error.message
    });

    return {
      success: false,
      customerId: null,
      loanApplicationIds: [],
      error: error.message
    };
  }
}
