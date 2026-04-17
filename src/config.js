import 'dotenv/config';

// Service configuration mappings
export const SERVICE_MAP = {
  LSP: { baseUrl: process.env.LSP_URL || 'http://localhost:4232', name: 'LSP' },
  GW: { baseUrl: process.env.GW_URL || 'http://localhost:2344', name: 'Gateway' }
};

// API endpoint mapping based on (sourceDestination, logTag) combination
// Key format: "sourceDestination|logTag" where sourceDestination is "SOURCE_DEST"
// Optional headers field for custom headers per endpoint
export const API_TO_ENDPOINT_MAP = {
  // 'LSP_GW|LSP-Eligibility_OUTGOING': { endpoint: '/v1/themis/eligibility', method: 'POST', service: 'GW', headers: {} },
  // 'GW_LSP|LSP-Eligibility_INCOMING': { endpoint: '/v1/themis/eligibility/callback', method: 'POST', service: 'LSP', headers: {} },
  'APP_WRAPPER|FlipKart-Eligibility_INCOMING': { endpoint: 'flipkart/eligibility', method: 'POST', service: 'LSP', headers: {'disable_encryption': 'TRUE', 'authorization': 'Basic flipkart'} },
  'APP_WRAPPER|FlipKart-EligibilityStatus_INCOMING': { endpoint: '/flipkart/eligibility/status', method: 'POST', service: 'LSP', headers: {'disable_encryption': 'TRUE', 'authorization': 'Basic flipkart'} },
  'LSP_GW|LSP-Eligibility_OUTGOING': { endpoint: '/gateway/v1.0/eligibility', method: 'POST', service: 'GW', headers: {} },
  'GW_LENDER|Themis-Eligibility Request': { endpoint: '/lsp/softEligibility', method: 'POST', service: 'GATEWAY', headers: {} },
  'LENDER_GW|WEBHOOK Request': { endpoint: '/gateway/webhook', method: 'POST', service: 'GATEWAY', headers: {} },
  // 'LENDER_GW|Themis-Eligibility Response': { endpoint: '/v1/themis/gateway/response', method: 'POST', service: 'GW', headers: {} },
  // 'LENDER_GW|ThemisGenerateOffersResponse Response': { endpoint: '/v1/themis/offers/response', method: 'POST', service: 'GW', headers: {} }
};

// API endpoint mapping: endpoint -> { logTag, api, sourceDestination, headers }
export const API_TO_LOGTAG_MAP = {
  // '/v1/themis/eligibility': { logTag: 'LSP-Eligibility_OUTGOING', api: '/v1/themis/eligibility', sourceDestination: 'LSP_GW', headers: {} },
  // '/v1/themis/eligibility/callback': { logTag: 'LSP-Eligibility_INCOMING', api: '/v1/themis/eligibility/callback', sourceDestination: 'GW_LSP', headers: {} },
  '/lsp/softEligibility': { logTag: 'Themis-Eligibility Request', api: '/lsp/softEligibility', sourceDestination: 'GW_LENDER', headers: {} },
  '/gateway/v1.0/eligibility': { logTag: 'LSP-Eligibility_OUTGOING', api: '/gateway/v1.0/eligibility', sourceDestination: 'LSP_GW', headers: {} },
  '/flipkart/eligibility': { logTag: 'FlipKart-Eligibility_INCOMING', api: '/flipkart/eligibility', sourceDestination: 'APP_WRAPPER', headers: {} },
  '/flipkart/eligibility/status': { logTag: 'FlipKart-EligibilityStatus_INCOMING', api: '/flipkart/eligibility/status', sourceDestination: 'APP_WRAPPER', headers: {} },
  // '/v1/themis/gateway/request': { logTag: 'Themis-Eligibility Request', api: '/v1/themis/gateway/request', sourceDestination: 'GW_LENDER', headers: {} },
  // '/v1/themis/gateway/response': { logTag: 'Themis-Eligibility Response', api: '/v1/themis/gateway/response', sourceDestination: 'LENDER_GW', headers: {} },
  // '/v1/themis/offers/response': { logTag: 'ThemisGenerateOffersResponse Response', api: '/v1/themis/offers/response', sourceDestination: 'LENDER_GW', headers: {} }
};

// Destinations that should not be called (external services)
export const SKIP_DESTINATIONS = ['APP', 'LENDER'];

// Async/parallel API calls that can arrive out of order
// Format: { sourceDestination: string, logTagPattern: string | RegExp }
// These APIs are made in parallel by the source service and can arrive in any order
export const ASYNC_PARALLEL_APIS = [
  { sourceDestination: 'GW_LENDER', logTagPattern: /^Themis-Eligibility/ }
];

/**
 * Check if an API call is async/parallel (can arrive out of order)
 * @param {string} sourceDestination - Source to destination (e.g., "GW_LENDER")
 * @param {string} logTag - The log tag for the API
 * @returns {boolean}
 */
export function isAsyncParallelApi(sourceDestination, logTag) {
  return ASYNC_PARALLEL_APIS.some(api => {
    if (api.sourceDestination !== sourceDestination) return false;
    if (typeof api.logTagPattern === 'string') {
      return logTag === api.logTagPattern;
    }
    return api.logTagPattern.test(logTag);
  });
}

// Orchestrator server configuration
export const ORCHESTRATOR_CONFIG = {
  port: parseInt(process.env.PORT, 10) || 3001,
  timeoutMs: parseInt(process.env.TIMEOUT_MS, 10) || 10000,
  autoStart: process.env.AUTO_START !== 'false'
};

// Mock configuration
export const MOCK_CONFIG = {
  enabled: process.env.MOCK_ENABLED === 'true',
  // When mocks are enabled, these URLs override SERVICE_MAP
  mockLspUrl: process.env.MOCK_LSP_URL || 'http://127.0.0.1:4232',
  mockGwUrl: process.env.MOCK_GW_URL || 'http://127.0.0.1:2344'
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
 * Get API endpoint for a log tag (reverse lookup from API_TO_LOGTAG_MAP)
 * @param {string} logTag - The log tag
 * @returns {string|null} - The API endpoint
 */
export function getApiForLogTag(logTag) {
  const entry = Object.values(API_TO_LOGTAG_MAP).find(m => m.logTag === logTag);
  return entry?.api || null;
}

/**
 * Get endpoint config for a logTag and sourceDestination
 * Tries remapped version first (APP_LSP), falls back to original (APP_WRAPPER)
 * @param {string} sourceDestination
 * @param {string} logTag
 * @returns {Object|null}
 */
export function getEndpointConfig(sourceDestination, logTag) {
  // Try the provided sourceDestination first
  const key = `${sourceDestination}|${logTag}`;
  if (API_TO_ENDPOINT_MAP[key]) {
    return API_TO_ENDPOINT_MAP[key];
  }
  // If not found and it's a remapped version, try the original
  const remappings = {
    'APP_LSP': 'APP_WRAPPER',
    'LSP_APP': 'WRAPPER_APP'
  };
  const original = remappings[sourceDestination];
  if (original) {
    const originalKey = `${original}|${logTag}`;
    return API_TO_ENDPOINT_MAP[originalKey] || null;
  }
  return null;
}
