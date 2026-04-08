import { logger } from '../utils/logger.js';

/**
 * Simple HTTP client for service calls
 */

let mockResponses = {
  "POLLING API Request LSP_GW": {
    status: 200,
    statusText: 'OK',
    data: {
      message: 'Mock response for LSP_GW'
    },
    endpoint: '/api/polling',
    headers: { 'content-type': 'application/json' }
  },
  "POLLING API Response GW_LSP": {
    status: 200,
    statusText: 'OK',
    data: { message: 'Mock response for GW_LSP' },
    endpoint: '/api/applications',
    headers: { 'content-type': 'application/json' }
  }
};

export async function makeRequest(baseUrl, endpoint, method, payload, requestId, sourceDestination, logTag, merchantId) {
  const key = `${logTag} ${sourceDestination}`;

  logger.debug('Making HTTP request', {
    baseUrl,
    endpoint,
    method,
    requestId,
    sourceDestination,
    logTag,
    merchantId,
    mockKey: key
  });

  if (mockResponses[key]) {
    logger.debug('Using mock response', { key });
    return mockResponses[key];
  }

  const url = `${baseUrl}${endpoint}`;
  const headers = {
    'Content-Type': 'application/json',
    'x-request-id': requestId
  };

  // Add merchant ID to headers if provided
  if (merchantId) {
    headers['x-merchant-id'] = merchantId;
  }

  try {
    const response = await fetch(url, {
      method,
      headers,
      body: method !== 'GET' ? JSON.stringify(payload) : undefined
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
      headers: Object.fromEntries(response.headers.entries()),
      logTag: response.logTag,
      sourceDestination: response.sourceDestination
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
