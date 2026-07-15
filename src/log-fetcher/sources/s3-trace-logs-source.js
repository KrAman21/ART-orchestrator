import { logger } from '../../utils/logger.js';
import { LSP_API_CONFIG } from '../../config.js';

const DEFAULT_BASE_URL = LSP_API_CONFIG.baseUrl || 'https://api.juspay.in';

function extractLogsFromResponse(data) {
  if (data?.result && Array.isArray(data.result)) {
    return data.result;
  }

  if (Array.isArray(data) && data.length > 0 && Array.isArray(data[0]?.result)) {
    return data[0].result;
  }

  if (Array.isArray(data)) {
    return data;
  }

  return [];
}

function getTraceRoute(log) {
  return log?.trace_route || log?.traceRoute || '';
}

function getLogTag(log) {
  return log?.log_tag || log?.logTag || '';
}

function serializeFetchError(error) {
  const cause = error?.cause;

  return {
    error: error?.message || 'Unknown fetch error',
    errorName: error?.name || null,
    stack: error?.stack || null,
    causeMessage: cause?.message || null,
    causeName: cause?.name || null,
    causeCode: cause?.code || null,
    causeStack: cause?.stack || null,
    attemptedAddress: cause?.address || null,
    attemptedPort: cause?.port || null
  };
}

export function filterS3TraceLogs(logs) {
  return logs.filter(log => {
    const logTag = getLogTag(log);
    const traceRoute = getTraceRoute(log);

    if (logTag.includes('_ENCRYPTED')) {
      return false;
    }

    if (logTag.includes('.')) {
      return false;
    }

    if (traceRoute === 'CORE_APP') {
      return false;
    }

    return true;
  });
}

export async function fetchS3TraceLogsByLookup({
  id,
  idType,
  sessionToken = null,
  baseUrl = DEFAULT_BASE_URL,
  lookupOn = 'SECONDARY',
  label = idType
}) {
  const effectiveSessionToken = sessionToken || LSP_API_CONFIG.sessionToken;

  if (!effectiveSessionToken) {
    logger.error('Session token not provided for S3 Trace Logs API', { idType, id });
    return {
      success: false,
      error: 'Session token not provided',
      logs: [],
      count: 0,
      source: { id, idType, label }
    };
  }

  if (!id || !idType) {
    return {
      success: false,
      error: 'Both id and idType are required',
      logs: [],
      count: 0,
      source: { id, idType, label }
    };
  }

  const encodedId = encodeURIComponent(id);
  const encodedIdType = encodeURIComponent(idType);
  const endpoint = `/credit/api/v3.3/dashboard/getS3TraceLogs?lookup_on=${lookupOn}&id=${encodedId}&id_type=${encodedIdType}`;
  const url = `${baseUrl}${endpoint}`;

  logger.info('Fetching S3 Trace Logs', {
    label,
    id,
    idType,
    hasSessionToken: true
  });

  try {
    const response = await fetch(url, {
      method: 'GET',
      headers: {
        'Content-Type': 'application/json',
        'Accept': 'application/json',
        'session-token': effectiveSessionToken
      }
    });

    if (!response.ok) {
      const errorText = await response.text();
      logger.error('Failed to fetch S3 Trace Logs', {
        label,
        id,
        idType,
        status: response.status,
        statusText: response.statusText,
        error: errorText
      });

      return {
        success: false,
        error: `HTTP error! status: ${response.status}`,
        message: errorText,
        logs: [],
        count: 0,
        source: { id, idType, label }
      };
    }

    const data = await response.json();
    const logs = extractLogsFromResponse(data);
    const filteredLogs = filterS3TraceLogs(logs);
    const excludedCount = logs.length - filteredLogs.length;

    if (excludedCount > 0) {
      logger.info('Filtered out non-replayable logs from S3 Trace Logs', {
        label,
        id,
        idType,
        totalFetched: logs.length,
        excludedCount,
        remainingCount: filteredLogs.length
      });
    }

    logger.info('Successfully fetched S3 Trace Logs', {
      label,
      id,
      idType,
      logCount: filteredLogs.length
    });

    return {
      success: true,
      logs: filteredLogs,
      count: filteredLogs.length,
      source: { id, idType, label }
    };
  } catch (error) {
    const fetchErrorDetails = serializeFetchError(error);

    logger.error('Exception while fetching S3 Trace Logs', {
      label,
      id,
      idType,
      ...fetchErrorDetails
    });

    return {
      success: false,
      error: fetchErrorDetails.error,
      errorDetails: fetchErrorDetails,
      logs: [],
      count: 0,
      source: { id, idType, label }
    };
  }
}

export function fetchS3TraceLogsByOrder(merchantId, orderId, sessionToken = null) {
  return fetchS3TraceLogsByLookup({
    id: `${merchantId}/${orderId}`,
    idType: 'merchant_id/order_id',
    sessionToken,
    label: 'order'
  });
}

export function fetchS3TraceLogsByMerchantCustomer(merchantId, customerId, sessionToken = null) {
  return fetchS3TraceLogsByLookup({
    id: `${merchantId}/${customerId}`,
    idType: 'merchant_id/merchant_customer_id',
    sessionToken,
    label: 'merchant_customer'
  });
}

export function fetchS3TraceLogsByLoanApplicationId(loanApplicationId, sessionToken = null) {
  return fetchS3TraceLogsByLookup({
    id: loanApplicationId,
    idType: 'loan_application_id',
    sessionToken,
    label: 'loan_application'
  });
}
