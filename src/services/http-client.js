/**
 * Simple HTTP client for service calls
 */
export async function makeRequest(baseUrl, endpoint, method, payload, requestId) {
  const url = `${baseUrl}${endpoint}`;
  const headers = {
    'Content-Type': 'application/json',
    'x-request-id': requestId
  };

  try {
    const response = await fetch(url, {
      method,
      headers,
      body: method !== 'GET' ? JSON.stringify(payload) : undefined
    });

    const data = await response.json().catch(() => null);

    return {
      status: response.status,
      statusText: response.statusText,
      data,
      headers: Object.fromEntries(response.headers.entries())
    };
  } catch (error) {
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
      timeout: 5000
    });
    return response.ok;
  } catch {
    return false;
  }
}
