/**
 * Simple structured logger for ART Orchestrator
 */

const LOG_LEVELS = {
  DEBUG: 0,
  INFO: 1,
  WARN: 2,
  ERROR: 3
};

const CURRENT_LEVEL = LOG_LEVELS[process.env.LOG_LEVEL?.toUpperCase()] ?? LOG_LEVELS.INFO;

function formatTimestamp() {
  return new Date().toISOString();
}

function log(level, message, meta = {}) {
  if (LOG_LEVELS[level] < CURRENT_LEVEL) return;

  const logEntry = {
    timestamp: formatTimestamp(),
    level,
    message,
    ...meta
  };

  if (level === 'ERROR') {
    console.error(JSON.stringify(logEntry));
  } else if (level === 'WARN') {
    console.warn(JSON.stringify(logEntry));
  } else {
    console.log(JSON.stringify(logEntry));
  }
}

export const logger = {
  debug: (msg, meta) => log('DEBUG', msg, meta),
  info: (msg, meta) => log('INFO', msg, meta),
  warn: (msg, meta) => log('WARN', msg, meta),
  error: (msg, meta) => log('ERROR', msg, meta),

  // Specific log types for orchestrator
  logStart: (totalLogs) => log('INFO', 'Starting ART replay', { totalLogs }),
  logComplete: (summary) => log('INFO', 'ART replay completed', summary),

  logStep: (step, index, total, meta = {}) => {
    log('INFO', `Step ${index}/${total}: ${step}`, { stepIndex: index, totalSteps: total, ...meta });
  },

  logServiceCall: (source, destination, endpoint, method) => {
    log('INFO', 'Service call', { source, destination, endpoint, method });
  },

  logComparison: (logTag, sourceDestination, match, details = null) => {
    log('INFO', 'Log comparison', { logTag, sourceDestination, match, details });
  },

  logSkipped: (destination, reason) => {
    log('INFO', 'Skipped service call', { destination, reason });
  },

  logResponseStored: (logTag, sourceDestination, outputListSize) => {
    log('INFO', 'Response stored', { logTag, sourceDestination, outputListSize });
  },

  logHealthCheck: (serviceName, healthy) => {
    log('INFO', 'Health check', { service: serviceName, healthy });
  },

  logError: (error, context = {}) => {
    log('ERROR', error.message, { stack: error.stack, ...context });
  }
};

export default logger;
