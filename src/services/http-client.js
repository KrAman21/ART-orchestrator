import { logger } from '../utils/logger.js';
import { MOCK_CONFIG, QAPI_CONFIG } from '../config.js';
import { fetchS3TraceLogs as fetchS3TraceLogsFromClient } from '../log-fetcher/s3-trace-logs-client.js';

/**
 * Simple HTTP client for service calls
 * Routes to mock servers when MOCK_ENABLED is true
 */

export async function makeRequest(baseUrl, endpoint, method, payload, requestId, sourceDestination, logTag, merchantId, customHeaders = {}, logIndex = null) {
  // Parse destination from sourceDestination (format: "SOURCE_DEST")
  const parts = sourceDestination?.split('_') || [];
  const source = parts[0] || '';
  const dest = parts[1] || '';

  // Log API call if logIndex is provided
  if (logIndex !== null) {
    logger.logApiCall(source, dest, endpoint, 'REQUEST', logIndex);
  }

  logger.info('Making HTTP request', {
    baseUrl,
    endpoint,
    method,
    requestId,
    sourceDestination,
    dest,
    logTag,
    merchantId,
    customHeaders
  });

  // Detailed logging for LSP calls (port 8070)
  if (baseUrl.includes('8070')) {
    logger.info('=== LSP CALL INITIATED ===', {
      baseUrl,
      endpoint,
      url: `${baseUrl}${endpoint}`,
      method,
      requestId,
      logTag,
      headers: customHeaders,
      timestamp: new Date().toISOString()
    });
  }

  // When mocking is enabled, we use the mock server ports
  // The baseUrl already points to mock ports via config
  const url = `${baseUrl}${endpoint}`;
  const headers = {
    ...customHeaders,
    'x-request-id': requestId,
    'Content-Type': 'application/json',
    'Accept': 'application/json'
  };

  // Add loan_application_id for correlation if present in payload
  if (payload?.loan_application_id) {
    headers['x-loan-application-id'] = payload.loan_application_id;
  }

  // Add merchant ID to headers if provided
  if (merchantId) {
    headers['x-merchant-id'] = merchantId;
  }

  try {
    let body = method !== 'GET' ? JSON.stringify(payload ?? {}) : undefined;

    if (dest === 'WRAPPER' && body) {
      body = JSON.stringify(body);
      headers['disable_encryption'] = customHeaders['disable_encryption'] || 'TRUE';
      headers['authorization'] = customHeaders['authorization'] || 'Basic flipkart';
    }

    logger.info('Request body prepared', {
      bodyPreview: body ? body.substring(0, 200) + (body.length > 200 ? '...' : '') : null,
      contentType: headers['Content-Type']
    });

    if (baseUrl.includes('8070')) {
      logger.info('=== LSP REQUEST DETAILS ===', {
        url,
        method,
        headers: { ...headers },
        body: body,
        requestId,
        logTag,
        timestamp: new Date().toISOString()
      });
    }

    const response = await fetch(url, {
      method,
      headers,
      body
    });

    const data = await response.json().catch(() => null);

    // Detailed logging for LSP calls (port 8070)
    if (baseUrl.includes('8070')) {
      logger.info('=== LSP CALL RESPONSE ===', {
        url,
        status: response.status,
        statusText: response.statusText,
        ok: response.ok,
        hasData: !!data,
        dataKeys: data ? Object.keys(data) : [],
        error: !response.ok ? (data?.error || 'HTTP error') : null,
        requestId,
        timestamp: new Date().toISOString()
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
      error: error.message
    });

    return {
      error: true,
      message: error.message,
      status: 0
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
export async function triggerWebhook(gwBaseUrl, lenderOrgId, payload, headers = {}) {
  const endpoint = `/gateway/webhook/${lenderOrgId}`;
  const url = `${gwBaseUrl}${endpoint}`;

  logger.info('Triggering webhook to GW', {
    endpoint,
    lenderOrgId,
    payloadPreview: payload ? JSON.stringify(payload).substring(0, 200) : null
  });

  try {
    const response = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Accept': 'application/json',
        ...headers
      },
      body: JSON.stringify(payload)
    });

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
    const response = await fetch(`${serviceConfig.baseUrl}/health`, {
      method: 'GET',
      timeout: 2000
    });

    const healthy = response.ok;
    logger.logHealthCheck(serviceConfig.name, healthy);

    return healthy;
  } catch (error) {
    logger.logHealthCheck(serviceConfig.name, false);
    return false;
  }
}

export { fetchS3TraceLogsFromClient as fetchS3TraceLogs };

export async function fetchOrderIdsFromQAPI(startDate, endDate, merchantIds = null) {
  logger.info('Fetching order IDs from QAPI', {
    startDate,
    endDate,
    merchantId: QAPI_CONFIG.merchantId,
    merchantIds: merchantIds || [QAPI_CONFIG.merchantId]
  });

  const endpoint = '/credit/q/query';
  const url = `${QAPI_CONFIG.baseUrl}${endpoint}`;

  const payload = {
    metric: "fetch_order_id",
    dimensions: [],
    filters: {
      field: "merchant_id",
      condition: "In",
      val: merchantIds || [QAPI_CONFIG.merchantId]
    },
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
        'X-Web-LoginToken': QAPI_CONFIG.token,
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
