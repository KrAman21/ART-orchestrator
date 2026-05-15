import { appendFileSync, mkdirSync, writeFileSync } from 'fs';
import { dirname, resolve } from 'path';
import { AsyncLocalStorage } from 'async_hooks';

const LOG_LEVELS = {
  DEBUG: 0,
  INFO: 1,
  WARN: 2,
  ERROR: 3
};

const CURRENT_LEVEL = LOG_LEVELS[process.env.LOG_LEVEL?.toUpperCase()] ?? LOG_LEVELS.INFO;
const LOG_FILE = process.env.LOG_FILE || 'orchestrator-output.log';
const LOG_TO_FILE = process.env.LOG_TO_FILE !== 'false';

const LOG_FILE_PATH = resolve(process.cwd(), LOG_FILE);

const GLOBAL_KEY = '__art_logger_initialized__';
if (LOG_TO_FILE && !global[GLOBAL_KEY]) {
  try {
    mkdirSync(dirname(LOG_FILE_PATH), { recursive: true });
    writeFileSync(LOG_FILE_PATH, '', { encoding: 'utf-8' });
    global[GLOBAL_KEY] = true;
    console.log(`[LOGGER_INIT] Initialized log file: ${LOG_FILE_PATH}`);
  } catch (error) {
    console.error(`[LOGGER_INIT] Failed: ${error.message}`);
  }
} else if (LOG_TO_FILE) {
  console.log(`[LOGGER_INIT] Already initialized, skipping file clear`);
}

const sessionContext = new AsyncLocalStorage();

const subscribers = new Map();
let subscriberCounter = 0;

function formatTimestamp() {
  return new Date().toISOString();
}

function logToFile(logEntry) {
  if (!LOG_TO_FILE) return;

  try {
    const line = JSON.stringify(logEntry) + '\n';
    appendFileSync(LOG_FILE_PATH, line, { encoding: 'utf-8' });
  } catch (_) {}
}

function log(level, message, meta = {}) {
  if (LOG_LEVELS[level] < CURRENT_LEVEL) return;

  const store = sessionContext.getStore();
  const sessionId = store?.sessionId || null;

  const logEntry = {
    timestamp: formatTimestamp(),
    level,
    message,
    ...meta
  };

  if (sessionId) {
    logEntry._sessionId = sessionId;
  }

  const line = JSON.stringify(logEntry);

  if (level === 'ERROR') {
    console.error(line);
  } else if (level === 'WARN') {
    console.warn(line);
  } else {
    console.log(line);
  }

  logToFile(logEntry);

  for (const [, callback] of subscribers) {
    try {
      callback(level, message, meta, sessionId);
    } catch (_) {}
  }
}

export function subscribe(callback) {
  const id = ++subscriberCounter;
  subscribers.set(id, callback);
  return id;
}

export function unsubscribe(id) {
  subscribers.delete(id);
}

export function runInSession(sessionId, fn) {
  return sessionContext.run({ sessionId }, fn);
}

export const logger = {
  debug: (msg, meta) => log('DEBUG', msg, meta),
  info: (msg, meta) => log('INFO', msg, meta),
  warn: (msg, meta) => log('WARN', msg, meta),
  error: (msg, meta) => log('ERROR', msg, meta),

  subscribe,
  unsubscribe,
  runInSession,

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

  logApiCall: (source, destination, apiName, type, logIndex) => {
    const arrow = source && destination ? `${source}->${destination}` : 'N/A';
    log('INFO', `API LOG :: ${arrow} ${apiName} ${type} ${logIndex}`);
  },

  logError: (error, context = {}) => {
    log('ERROR', error.message, { stack: error.stack, ...context });
  }
};

export default logger;
