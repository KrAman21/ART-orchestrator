import { logger } from '../utils/logger.js';
import { MOCK_CONFIG } from '../config.js';
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

export async function fetchOrderIdsFromQAPI(startDate, endDate) {
  logger.info('Fetching order IDs from QAPI (API call disabled - using dummy data)', {
    startDate,
    endDate,
    merchantId: QAPI_CONFIG.merchantId
  });

  /* API CALL DISABLED FOR TESTING
  const endpoint = '/credit/q/query';
  const url = `${QAPI_CONFIG.baseUrl}${endpoint}`;

  const payload = {
    metric: [
      "number_of_unique_leads",
      "soft_offer_qualified_leads",
      "hard_offer_requested_leads",
      "hard_offers_approved_leads",
      "number_of_active_lines",
      "avg_credit_line_amount"
    ],
    dimensions: ["order_id"],
    domain: "loanAnalytics",
    interval: {
      start: startDate,
      end: endDate
    },
    filters: {
      merchant_id: [QAPI_CONFIG.merchantId]
    }
  };

  try {
    const response = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Accept': 'application/json',
        'X-Web-LoginToken': QAPI_CONFIG.token,
        'Consumer-Credit-Dashboard': 'Consumer-Credit-Dashboard'
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

    const data = await response.json();

    if (!data || !data.result || !Array.isArray(data.result)) {
      logger.warn('QAPI returned unexpected format', { data });
      return {
        success: true,
        orderIds: [],
        count: 0,
        message: 'No order IDs found or unexpected response format'
      };
    }

    const orderIds = data.result
      .map(row => row.order_id)
      .filter(id => id && id.trim() !== '');

    logger.info('Successfully fetched order IDs from QAPI', {
      orderCount: orderIds.length,
      sampleOrders: orderIds.slice(0, 5)
    });

    return {
      success: true,
      orderIds,
      count: orderIds.length,
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
  */

  return {
    success: true,
    orderIds: [],
    count: 0,
    message: 'API call disabled - using dummy data'
  };
}
