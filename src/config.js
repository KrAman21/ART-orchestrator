// Service configuration mappings
export const SERVICE_MAP = {
  LSP: { baseUrl: process.env.LSP_URL || 'http://localhost:8080', name: 'LSP' },
  GW: { baseUrl: process.env.GW_URL || 'http://localhost:8081', name: 'Gateway' }
};

// API endpoint mapping based on source_destination and log_tag
export const API_ENDPOINT_MAP = {
  'LSP_TO_GW': {
    'POLLING API Response': { endpoint: '/api/polling', method: 'POST' },
    'SUBMIT_APPLICATION': { endpoint: '/api/applications', method: 'POST' },
    'STATUS_CHECK': { endpoint: '/api/status', method: 'GET' }
  },
  'GW_TO_LSP': {
    'LENDER_RESPONSE': { endpoint: '/api/callback/lender', method: 'POST' },
    'STATUS_CALLBACK': { endpoint: '/api/callback/status', method: 'POST' }
  }
};

// Destinations that should not be called (external services)
export const SKIP_DESTINATIONS = ['APP', 'LENDER'];
