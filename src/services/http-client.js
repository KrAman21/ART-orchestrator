import { logger } from '../utils/logger.js';
import { MOCK_CONFIG, QAPI_CONFIG } from '../config.js';
import { fetchS3TraceLogs as fetchS3TraceLogsFromClient } from '../log-fetcher/s3-trace-logs-client.js';
import { unixSocketRequest } from './unix-socket-client.js';
import crypto from 'crypto';
import { isAbsoluteUrl, resolveReplayEndpoint } from './replay-request-resolver.js';

function buildRequestUrl(baseUrl, endpoint) {
  if (isAbsoluteUrl(endpoint)) {
    const parsed = new URL(endpoint);
    return {
      url: endpoint,
      socketEndpoint: `${parsed.pathname}${parsed.search}`
    };
  }

  const socketEndpoint = resolveReplayEndpoint(endpoint) || endpoint;
  return {
    url: `${baseUrl}${socketEndpoint}`,
    socketEndpoint
  };
}

function inferMerchantIdFromEndpoint(endpoint) {
  if (typeof endpoint !== 'string') {
    return null;
  }

  if (endpoint.startsWith('/flipkartSM/')) {
    return 'flipkartSM';
  }

  if (endpoint.startsWith('/flipkart2w/')) {
    return 'flipkart2w';
  }

  if (endpoint.startsWith('/flipkart/')) {
    return 'flipkart';
  }

  return null;
}

function resolveMerchantIdForRequest(merchantId, customHeaders, endpoint) {
  return (
    merchantId ||
    customHeaders?.['x-merchant-id'] ||
    customHeaders?.['X-Merchant-Id'] ||
    inferMerchantIdFromEndpoint(endpoint) ||
    null
  );
}

function buildBasicMerchantAuthorization(merchantId) {
  return merchantId ? `Basic ${merchantId}` : 'Basic flipkart';
}

export async function makeRequest(baseUrl, endpoint, method, payload, requestId, sourceDestination, logTag, merchantId, customHeaders = {}, logIndex = null, unixSocket = null, timeoutMs = 30000) {
  const parts = sourceDestination?.split('_') || [];
  const source = parts[0] || '';
  const dest = parts[1] || '';

  if (logIndex !== null) {
    logger.logApiCall(source, dest, endpoint, 'REQUEST', logIndex);
  }

  logger.info('Making request', {
    baseUrl,
    endpoint,
    method,
    requestId,
    sourceDestination,
    dest,
    logTag,
    merchantId,
    customHeaders,
    unixSocket
  });

  const { url, socketEndpoint } = buildRequestUrl(baseUrl, endpoint);
  const resolvedMerchantId = resolveMerchantIdForRequest(merchantId, customHeaders, endpoint);
  const headers = {
    ...customHeaders,
    'Content-Type': 'application/json',
    'Accept': 'application/json'
  };

  // The payload may be transformed after we receive the original request.
  // Let the HTTP client recalculate body-specific/hop-by-hop headers.
  for (const headerName of ['content-length', 'Content-Length', 'host', 'Host', 'connection', 'Connection']) {
    delete headers[headerName];
  }

  if (requestId) {
    headers['x-request-id'] = requestId;
  }

  if (payload?.loan_application_id) {
    headers['x-loan-application-id'] = payload.loan_application_id;
  }

  // Add merchant ID to headers if provided
  if (resolvedMerchantId) {
    headers['x-merchant-id'] = resolvedMerchantId;
  }

  try {
    let body = method !== 'GET' ? JSON.stringify(payload ?? {}) : undefined;

    if (dest === 'WRAPPER' && body) {
      // body is already stringified above; just add WRAPPER-specific headers
      headers['disable_encryption'] = customHeaders['disable_encryption'] || 'TRUE';
      headers['authorization'] =
        customHeaders['authorization']
          ? customHeaders['authorization'].replace(/^Basic\s+.+$/i, buildBasicMerchantAuthorization(resolvedMerchantId))
          : buildBasicMerchantAuthorization(resolvedMerchantId);
      
      // When disable_encryption is TRUE, LSP expects body as JSON String (not Object)
      // because Servant route type is ReqBody '[JSON] Text
      if (headers['disable_encryption'] === 'TRUE') {
        body = JSON.stringify(body);
      }

      logger.info('Resolved WRAPPER authorization header', {
        merchantId,
        resolvedMerchantId,
        authorization: headers['authorization'],
        logTag,
        requestId
      });
    }

    logger.info('Request body prepared', {
      bodyPreview: body,
      contentType: headers['Content-Type']
    });

    const sendRequest = async (requestBody) => {
      if (unixSocket) {
        logger.info('Using Unix socket for request', { socket: unixSocket, serviceUrl: url, timeoutMs });
        const socketResponse = await unixSocketRequest(unixSocket, baseUrl, socketEndpoint, {
          method,
          body: requestBody,
          headers,
          timeout: timeoutMs
        });
        return {
          ok: socketResponse.ok,
          status: socketResponse.status,
          statusText: socketResponse.statusText,
          json: () => Promise.resolve(socketResponse.data),
          headers: new Map(Object.entries(socketResponse.headers || {}))
        };
      }

      return fetch(url, {
        method,
        headers,
        body: requestBody,
        signal: AbortSignal.timeout(timeoutMs)
      });
    };

    let response = await sendRequest(body);

    let data = await response.json().catch(() => null);

    logger.info('HTTP_RESPONSE_FULL_BODY', {
      requestId,
      url,
      status: response.status,
      statusText: response.statusText,
      data: data,
      dataString: data ? JSON.stringify(data) : null
    });

    if (
      sourceDestination === 'APP_CORE' &&
      method !== 'GET' &&
      response.status === 400 &&
      data?.expectedValue === 'String' &&
      data?.actualValue === 'Object' &&
      body
    ) {
      const requestPayload = {
        payload: payload ?? {},
        header: {
          'X-Merchant-Id': merchantId || payload?.merchantId || payload?.merchant_id || 'flipkart',
          ...(payload?.clientAuthToken ? { 'X-Client-Auth-Token': payload.clientAuthToken } : {}),
          ...customHeaders
        },
        timeStamp: new Date().toISOString(),
        requestId: requestId || payload?.requestId || crypto.randomUUID()
      };
      const retryBody = JSON.stringify(JSON.stringify(requestPayload));
      logger.warn('Retrying APP_CORE request as unencrypted JwtPayload text after LSP type mismatch', {
        requestId,
        endpoint,
        logTag,
        envelopeRequestId: requestPayload.requestId
      });

      response = await sendRequest(retryBody);
      data = await response.json().catch(() => null);

      logger.info('HTTP_RESPONSE_FULL_BODY', {
        requestId,
        url,
        status: response.status,
        statusText: response.statusText,
        data: data,
        dataString: data ? JSON.stringify(data) : null,
        retry: 'APP_CORE_UNENCRYPTED_JWT_TEXT'
      });
    }

    logger.debug('HTTP response received', {
      status: response.status,
      statusText: response.statusText
    });

    return {
      status: response.status,
      statusText: response.statusText,
      data,
      headers: Object.fromEntries(response.headers.entries())
    };
  } catch (error) {
    logger.error('HTTP request failed', {
      url,
      method,
      error: error.message,
      errorType: error.constructor?.name,
      errorStack: error.stack,
      errorCause: error.cause,
      baseUrl,
      endpoint,
      requestId,
      logTag
    });

    return {
      error: true,
      message: error.message,
      status: 0,
      errorType: error.constructor?.name,
      errorDetails: error.cause || null
    };
  }
}

/**
 * Trigger a webhook to GW
 * @param {string} gwBaseUrl - GW service base URL
 * @param {string} lenderOrgId - Lender organization ID for the webhook endpoint
 * @param {Object} payload - Webhook payload
 * @param {Object} headers - Additional headers
 * @returns {Promise<Object>} - Response from GW
 */
export async function triggerWebhook(gwBaseUrl, lenderOrgId, payload, headers = {}, gwUnixSocket = null) {
  const replayUrl = headers.__artReplayUrl;
  const method = headers.__artReplayMethod || 'POST';
  delete headers.__artReplayUrl;
  delete headers.__artReplayMethod;

  const endpoint = resolveReplayEndpoint(replayUrl) || `/gateway/webhook/${lenderOrgId}`;
  const { url, socketEndpoint } = buildRequestUrl(gwBaseUrl, endpoint);

  logger.info('Triggering webhook to GW', {
    endpoint,
    method,
    lenderOrgId,
    payloadPreview: payload ? JSON.stringify(payload).substring(0, 200) : null
  });

  try {
    let response;
    if (gwUnixSocket) {
      logger.info('Using Unix socket for webhook request', { socket: gwUnixSocket, url });
      const socketResponse = await unixSocketRequest(gwUnixSocket, gwBaseUrl, socketEndpoint, {
        method,
        body: JSON.stringify(payload),
        headers: {
          'Content-Type': 'application/json',
          'Accept': 'application/json',
          ...headers
        }
      });
      response = {
        ok: socketResponse.ok,
        status: socketResponse.status,
        statusText: socketResponse.statusText,
        json: () => Promise.resolve(socketResponse.data)
      };
    } else {
      response = await fetch(url, {
        method,
        headers: {
          'Content-Type': 'application/json',
          'Accept': 'application/json',
          ...headers
        },
        body: JSON.stringify(payload)
      });
    }

    const data = await response.json().catch(() => null);

    logger.info('Webhook triggered successfully', {
      endpoint,
      status: response.status
    });

    return {
      status: response.status,
      statusText: response.statusText,
      data,
      success: response.ok
    };
  } catch (error) {
    logger.error('Failed to trigger webhook', {
      url,
      error: error.message
    });

    return {
      error: true,
      message: error.message,
      success: false
    };
  }
}

/**
 * Health check for services
 */
export async function checkHealth(serviceConfig) {
  try {
    let response;
    if (serviceConfig.unixSocket) {
      const socketResponse = await unixSocketRequest(serviceConfig.unixSocket, serviceConfig.baseUrl, '/health', {
        method: 'GET',
        timeout: 2000
      });
      response = { ok: socketResponse.ok };
    } else {
      response = await fetch(`${serviceConfig.baseUrl}/health`, {
        method: 'GET',
        timeout: 2000
      });
    }

    const healthy = response.ok;
    logger.logHealthCheck(serviceConfig.name, healthy);

    return healthy;
  } catch (error) {
    logger.logHealthCheck(serviceConfig.name, false);
    return false;
  }
}

export { fetchS3TraceLogsFromClient as fetchS3TraceLogs };

function buildOrderFetchFilters(merchantIds, queryFilters = {}) {
  const normalizedMerchantIds = Array.isArray(merchantIds)
    ? merchantIds.filter(Boolean).map(id => String(id).trim()).filter(Boolean)
    : [];
  const merchantId = queryFilters.merchantId || normalizedMerchantIds[0] || QAPI_CONFIG.merchantId;
  const flowType = queryFilters.flowType ? String(queryFilters.flowType).trim() : '';
  const subType = queryFilters.subType ? String(queryFilters.subType).trim() : '';

  if (flowType || subType) {
    let filters = {
      field: 'merchant_id',
      condition: 'Equals',
      val: merchantId
    };

    if (flowType) {
      filters = {
        and: {
          left: filters,
          right: {
            field: 'flow_type',
            condition: 'Equals',
            val: flowType
          }
        }
      };
    }

    if (subType) {
      filters = {
        and: {
          left: filters,
          right: {
            field: 'sub_type',
            condition: 'Equals',
            val: subType
          }
        }
      };
    }

    return filters;
  }

  return {
    field: 'merchant_id',
    condition: 'In',
    val: normalizedMerchantIds.length > 0 ? normalizedMerchantIds : [QAPI_CONFIG.merchantId]
  };
}

export async function fetchOrderIdsFromQAPI(startDate, endDate, merchantIds = null, queryFilters = {}) {
  logger.info('Fetching order IDs from QAPI', {
    startDate,
    endDate,
    merchantId: QAPI_CONFIG.merchantId,
    merchantIds: merchantIds || [QAPI_CONFIG.merchantId],
    queryFilters
  });

  const endpoint = '/analytics/query';
  const url = `${QAPI_CONFIG.baseUrl}${endpoint}`;

  const payload = {
    metric: "fetch_order_id",
    dimensions: [],
    filters: buildOrderFetchFilters(merchantIds, queryFilters),
    domain: "orderAnalytics",
    interval: {
      start: startDate,
      end: endDate
    }
  };

  try {
    const response = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Accept': 'application/json',
        'Authorization': QAPI_CONFIG.authorization,
        'Consumer-Credit-Dashboard': 'Consumer-Credit-Dashboard',
        'Referer': 'https://dashboard.credit.juspay.in/'
      },
      body: JSON.stringify(payload)
    });

    if (!response.ok) {
      const errorText = await response.text();
      logger.error('Failed to fetch order IDs from QAPI', {
        status: response.status,
        statusText: response.statusText,
        error: errorText
      });
      return {
        success: false,
        error: `HTTP error! status: ${response.status}`,
        message: errorText
      };
    }

    const responseText = await response.text();
    let data;
    
    try {
      data = JSON.parse(responseText);
    } catch (e) {
      const lines = responseText.split('\n').filter(l => l.trim());
      try {
        const parsed = lines.map(line => JSON.parse(line)).filter(Boolean);
        data = { result: parsed, status: 'SUCCESS' };
      } catch (e2) {
        logger.error('Failed to parse QAPI response as both JSON and NDJSON', {
          error: e2.message,
          lineCount: lines.length,
          preview: responseText.substring(0, 200)
        });
        return {
          success: false,
          error: `Failed to parse QAPI response: ${e.message}`
        };
      }
    }

    logger.info('QAPI raw response preview', { preview: responseText.substring(0, 500) });

    logger.info('QAPI response received', { 
      status: data.status,
      hasResult: !!data.result,
      resultType: typeof data.result,
      isResultArray: Array.isArray(data.result),
      resultLength: Array.isArray(data.result) ? data.result.length : 0,
      keys: Object.keys(data)
    });

    let resultRows = [];
    if (data.result && Array.isArray(data.result)) {
      resultRows = data.result;
    } else if (data.result && typeof data.result === 'object' && data.result.rows) {
      resultRows = data.result.rows;
    } else if (data.data && Array.isArray(data.data)) {
      resultRows = data.data;
    } else if (Array.isArray(data)) {
      resultRows = data;
    }

    if (resultRows.length === 0) {
      logger.warn('QAPI returned no order IDs', { responseKeys: Object.keys(data), rawPreview: JSON.stringify(data).substring(0, 500) });
      return {
        success: true,
        orders: [],
        count: 0,
        message: 'No order IDs found or unexpected response format'
      };
    }

    logger.info('QAPI result sample', { firstRow: JSON.stringify(resultRows[0]).substring(0, 300) });

    const normalizedRows = resultRows.map(row => {
      if (typeof row === 'string') {
        try {
          return JSON.parse(row);
        } catch (e) {
          return { raw: row };
        }
      }
      return row;
    });

    const orders = normalizedRows
      .map(row => ({
        orderId: row.fetch_order_id || row.order_id || row.orderId || row.ORDER_ID || row.id || null,
        merchantId: row.merchant_id || row.merchantId || row.MERCHANT_ID || merchantIds[0] || QAPI_CONFIG.merchantId
      }))
      .filter(o => o.orderId && String(o.orderId).trim() !== '');

    const uniqueOrders = [];
    const seen = new Set();
    for (const o of orders) {
      if (!seen.has(o.orderId)) {
        seen.add(o.orderId);
        uniqueOrders.push(o);
      }
    }

    logger.info('Successfully fetched order IDs from QAPI', {
      rawCount: orders.length,
      uniqueCount: uniqueOrders.length,
      duplicatesRemoved: orders.length - uniqueOrders.length,
      sampleOrders: uniqueOrders.slice(0, 5)
    });

    return {
      success: true,
      orders: uniqueOrders,
      orderIds: uniqueOrders.map(o => o.orderId),
      count: uniqueOrders.length,
      rawData: data
    };

  } catch (error) {
    logger.error('Exception while fetching order IDs from QAPI', {
      startDate,
      endDate,
      error: error.message,
      stack: error.stack
    });

    return {
      success: false,
      error: error.message
    };
  }
}
