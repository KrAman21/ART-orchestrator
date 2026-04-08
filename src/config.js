// Service configuration mappings
export const SERVICE_MAP = {
  LSP: { baseUrl: process.env.LSP_URL || 'http://localhost:4232', name: 'LSP' },
  GW: { baseUrl: process.env.GW_URL || 'http://localhost:2344', name: 'Gateway' }
};

// API endpoint mapping based on (sourceDestination, logTag) combination
// Key format: "sourceDestination|logTag" where sourceDestination is "SOURCE_DEST"
export const API_TO_ENDPOINT_MAP = {
  'LSP_GW|POLLING API Request': { endpoint: '/api/polling', method: 'POST', service: 'GW' },
  'LSP_GW|SUBMIT_APPLICATION': { endpoint: '/api/applications', method: 'POST', service: 'GW' },
  'LSP_GW|STATUS_CHECK': { endpoint: '/api/status', method: 'GET', service: 'GW' },
  'GW_LSP|POLLING API Response': { endpoint: '/api/polling/response', method: 'POST', service: 'LSP' },
  'GW_LSP|LENDER_RESPONSE': { endpoint: '/api/callback/lender', method: 'POST', service: 'LSP' },
  'GW_LSP|STATUS_CALLBACK': { endpoint: '/api/callback/status', method: 'POST', service: 'LSP' }
};

// Reverse mapping: endpoint -> (sourceDestination, logTag)
// Used for looking up response log metadata from endpoint
export const ENDPOINT_API_MAP = {
  '/api/polling': { sourceDestination: 'GW_LSP', logTag: 'POLLING API Response' },
  '/api/applications': { sourceDestination: 'GW_LSP', logTag: 'SUBMIT_APPLICATION Response' }
};

// API endpoint mapping: endpoint -> { logTag, api, sourceDestination }
export const API_TO_LOGTAG_MAP = {
  '/api/polling': { logTag: 'POLLING API Request', api: '/api/polling', sourceDestination: 'LSP_GW' },
  '/api/applications': { logTag: 'SUBMIT_APPLICATION', api: '/api/applications', sourceDestination: 'LSP_GW' },
  '/api/status': { logTag: 'STATUS_CHECK', api: '/api/status', sourceDestination: 'LSP_GW' },
  '/api/callback/lender': { logTag: 'LENDER_RESPONSE', api: '/api/callback/lender', sourceDestination: 'GW_LSP' },
  '/api/callback/status': { logTag: 'STATUS_CALLBACK', api: '/api/callback/status', sourceDestination: 'GW_LSP' },
  '/api/polling/response': { logTag: 'POLLING API Response', api: '/api/polling/response', sourceDestination: 'GW_LSP' }
};

// Destinations that should not be called (external services)
export const SKIP_DESTINATIONS = ['APP', 'LENDER'];

// Orchestrator server configuration
export const ORCHESTRATOR_CONFIG = {
  port: parseInt(process.env.PORT, 10) || 3001,
  timeoutMs: parseInt(process.env.TIMEOUT_MS, 10) || 30000,
  autoStart: process.env.AUTO_START !== 'false'
};

/**
 * Extract the payload from message based on log_tag type
 * - If log_tag ends with "Request" -> use message.trace_request
 * - If log_tag ends with "Response" -> use message.trace_response
 * @param {Object} message - The log message object
 * @param {string} logTag - The log tag
 * @returns {Object|null} - The extracted payload
 */
export function extractPayload(message, logTag) {
  if (!logTag || typeof logTag !== 'string') {
    return null;
  }

  const trimmedTag = logTag.trim();

  if (trimmedTag.endsWith('Request') || trimmedTag.endsWith('_INCOMING')) {
    return message?.trace_request || null;
  }

  if (trimmedTag.endsWith('Response') || trimmedTag.endsWith('_OUTGOING')) {
    return message?.trace_response || null;
  }

  // Default: return null if neither Request nor Response
  return null;
}

/**
 * Get LogTag for an API endpoint
 * @param {string} api - API endpoint path
 * @returns {string|null}
 */
export function getLogTagForApi(api) {
  return API_TO_LOGTAG_MAP[api]?.logTag || null;
}

/**
 * Get full mapping info for an API endpoint
 * @param {string} api - API endpoint path
 * @returns {Object|null} - { logTag, api, sourceDestination }
 */
export function getApiMapping(api) {
  return API_TO_LOGTAG_MAP[api] || null;
}

/**
 * Get endpoint config for a logTag and sourceDestination
 * @param {string} sourceDestination
 * @param {string} logTag
 * @returns {Object|null}
 */
export function getEndpointConfig(sourceDestination, logTag) {
  const key = `${sourceDestination}|${logTag}`;
  return API_TO_ENDPOINT_MAP[key] || null;
}
