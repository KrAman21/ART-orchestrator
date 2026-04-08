// Service configuration mappings
export const SERVICE_MAP = {
  LSP: { baseUrl: process.env.LSP_URL || 'http://localhost:4232', name: 'LSP' },
  GW: { baseUrl: process.env.GW_URL || 'http://localhost:2344', name: 'Gateway' }
};

// API endpoint mapping based on (sourceDestination, logTag) combination
// Key format: "sourceDestination|logTag"
export const API_ENDPOINT_MAP = {
  'LSP_TO_GW|POLLING API Request': { endpoint: '/api/polling', method: 'POST', service: 'GW' },
  'LSP_TO_GW|SUBMIT_APPLICATION': { endpoint: '/api/applications', method: 'POST', service: 'GW' },
  'LSP_TO_GW|STATUS_CHECK': { endpoint: '/api/status', method: 'GET', service: 'GW' },
  'GW_TO_LSP|POLLING API Response': { endpoint: '/api/polling', method: 'POST', service: 'LSP' },
  'GW_TO_LSP|LENDER_RESPONSE': { endpoint: '/api/callback/lender', method: 'POST', service: 'LSP' },
  'GW_TO_LSP|STATUS_CALLBACK': { endpoint: '/api/callback/status', method: 'POST', service: 'LSP' }
};

// Reverse mapping: endpoint -> (sourceDestination, logTag)
// Used for looking up response log metadata from endpoint
export const ENDPOINT_API_MAP = {
  '/api/polling': {sourceDestination: 'LSP_TO_GW', logTag: 'POLLING API Request'},
  '/api/applications': {sourceDestination: 'GW_TO_LSP', logTag: 'POLLING API Response'}
};

// Destinations that should not be called (external services)
export const SKIP_DESTINATIONS = ['APP', 'LENDER'];

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

  if (trimmedTag.endsWith('Request')) {
    return message?.trace_request || null;
  }

  if (trimmedTag.endsWith('Response')) {
    return message?.trace_response || null;
  }

  // Default: return null if neither Request nor Response
  return null;
}
