import { logger } from '../utils/logger.js';
import { MOCK_CONFIG } from '../config.js';

/**
 * Simple HTTP client for service calls
 * Routes to mock servers when MOCK_ENABLED is true
 */

export async function makeRequest(baseUrl, endpoint, method, payload, requestId, sourceDestination, logTag, merchantId, customHeaders = {}) {
  // Parse destination from sourceDestination (format: "SOURCE_DEST")
  const dest = sourceDestination?.split('_')[1] || '';

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

    // Double-stringify if destination is WRAPPER
    if (dest === 'WRAPPER' && body) {
      body = JSON.stringify(body);
      headers['disable_encryption'] = customHeaders['disable_encryption'] || 'TRUE';
      headers['authorization'] = customHeaders['authorization'] || 'Basic flipkart';
      logger.info('Double-stringified body for WRAPPER destination');
    }

    logger.info('Request body prepared', {
      bodyPreview: body ? body.substring(0, 200) + (body.length > 200 ? '...' : '') : null,
      contentType: headers['Content-Type']
    });

    const response = await fetch(url, {
      method,
      headers,
      body
    });

    const data = await response.json().catch(() => null);

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
