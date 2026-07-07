import { appendFileSync, mkdirSync, writeFileSync, accessSync, constants } from 'fs';
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
const DIRECTION_LOGS_TO_FILE = process.env.DIRECTION_LOGS_TO_FILE !== 'false';
const REQUEST_FLOW_LOGS_TO_FILE = process.env.REQUEST_FLOW_LOGS_TO_FILE !== 'false';

function canWriteToDir(dirPath) {
  try {
    accessSync(dirPath, constants.W_OK);
    return true;
  } catch {
    return false;
  }
}

function getDefaultLogDir() {
  const cwd = process.cwd();
  if (canWriteToDir(cwd)) {
    return cwd;
  }

  const candidates = [
    process.env.XDG_STATE_HOME && resolve(process.env.XDG_STATE_HOME, 'art-orchestrator'),
    process.env.HOME && resolve(process.env.HOME, '.local', 'state', 'art-orchestrator'),
    process.env.TMPDIR && resolve(process.env.TMPDIR, 'art-orchestrator'),
    '/tmp/art-orchestrator'
  ].filter(Boolean);

  return candidates.find(canWriteToDir) || '/tmp/art-orchestrator';
}

function resolveLogPath(envPath, fileName) {
  if (envPath) {
    return resolve(process.cwd(), envPath);
  }

  return resolve(LOG_DIR, fileName);
}

const LOG_DIR = getDefaultLogDir();
const LOG_FILE_PATH = resolveLogPath(LOG_FILE, 'orchestrator-output.log');
const INCOMING_LOG_FILE = process.env.INCOMING_LOG_FILE
  ? resolve(process.cwd(), process.env.INCOMING_LOG_FILE)
  : resolve(LOG_DIR, 'art-incoming.log');
const OUTGOING_LOG_FILE = process.env.OUTGOING_LOG_FILE
  ? resolve(process.cwd(), process.env.OUTGOING_LOG_FILE)
  : resolve(LOG_DIR, 'art-outgoing.log');
const REQUEST_FLOW_LOG_FILE_PATH = process.env.REQUEST_FLOW_LOG_FILE
  ? resolve(process.cwd(), process.env.REQUEST_FLOW_LOG_FILE)
  : resolve(LOG_DIR, 'art-request-flow.log');

function initLogFile(filePath) {
  try {
    mkdirSync(dirname(filePath), { recursive: true });
    writeFileSync(filePath, '', { encoding: 'utf-8' });
  } catch (_) {}
}

const GLOBAL_KEY = '__art_logger_initialized__';
if ((LOG_TO_FILE || DIRECTION_LOGS_TO_FILE || REQUEST_FLOW_LOGS_TO_FILE) && !global[GLOBAL_KEY]) {
  try {
    if (LOG_TO_FILE) {
      initLogFile(LOG_FILE_PATH);
    }
    if (DIRECTION_LOGS_TO_FILE) {
      initLogFile(INCOMING_LOG_FILE);
      initLogFile(OUTGOING_LOG_FILE);
    }
    if (REQUEST_FLOW_LOGS_TO_FILE) {
      initLogFile(REQUEST_FLOW_LOG_FILE_PATH);
    }
    global[GLOBAL_KEY] = true;
    console.log(
      `[LOGGER_INIT] Initialized log files: ${[
        LOG_TO_FILE ? LOG_FILE_PATH : null,
        DIRECTION_LOGS_TO_FILE ? INCOMING_LOG_FILE : null,
        DIRECTION_LOGS_TO_FILE ? OUTGOING_LOG_FILE : null,
        REQUEST_FLOW_LOGS_TO_FILE ? REQUEST_FLOW_LOG_FILE_PATH : null
      ].filter(Boolean).join(', ')}`
    );
  } catch (error) {
    console.error(`[LOGGER_INIT] Failed: ${error.message}`);
  }
} else if (LOG_TO_FILE || DIRECTION_LOGS_TO_FILE || REQUEST_FLOW_LOGS_TO_FILE) {
  console.log(`[LOGGER_INIT] Already initialized, skipping file clear`);
}

const sessionContext = new AsyncLocalStorage();
let directionLogReplayContext = null;

const subscribers = new Map();
let subscriberCounter = 0;

function formatTimestamp() {
  return new Date().toISOString();
}

function logToFile(logEntry, filePath = LOG_FILE_PATH) {
  if (!LOG_TO_FILE) return;

  try {
    const line = JSON.stringify(logEntry) + '\n';
    appendFileSync(filePath, line, { encoding: 'utf-8' });
  } catch (_) {}
}

function logToDirectionFile(direction, logEntry) {
  if (!DIRECTION_LOGS_TO_FILE) return;
  const filePath = direction === 'incoming' ? INCOMING_LOG_FILE : OUTGOING_LOG_FILE;
  try {
    const replayMeta = directionLogReplayContext
      ? {
          replayAttempt: directionLogReplayContext.replayAttempt,
          rewind: directionLogReplayContext.rewind,
          replayOrderId: directionLogReplayContext.orderId || null
        }
      : {};
    const entry = { ...logEntry, ...replayMeta, _direction: direction, _timestamp: formatTimestamp() };
    const line = JSON.stringify(entry) + '\n';
    appendFileSync(filePath, line, { encoding: 'utf-8' });
  } catch (_) {}
}

function logToRequestFlowFile(logEntry) {
  if (!REQUEST_FLOW_LOGS_TO_FILE) return;

  try {
    const entry = {
      timestamp: logEntry?.timestamp || formatTimestamp(),
      ...logEntry
    };
    const line = JSON.stringify(entry) + '\n';
    appendFileSync(REQUEST_FLOW_LOG_FILE_PATH, line, { encoding: 'utf-8' });
  } catch (_) {}
}

function prioritizeDirectionLogFields(logEntry = {}) {
  const preferredOrder = [
    'timestamp',
    'entryIndex',
    'logIndex',
    'replayAttempt',
    'rewind',
    'replayOrderId',
    'direction',
    'event',
    'source',
    'destination',
    'api',
    'requestId',
    'logTag',
    'sourceDestination'
  ];

  const prioritized = {};

  for (const key of preferredOrder) {
    if (Object.prototype.hasOwnProperty.call(logEntry, key)) {
      prioritized[key] = logEntry[key];
    }
  }

  for (const [key, value] of Object.entries(logEntry)) {
    if (!Object.prototype.hasOwnProperty.call(prioritized, key)) {
      prioritized[key] = value;
    }
  }

  return prioritized;
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

export function setDirectionLogReplayContext(context = {}) {
  directionLogReplayContext = {
    orderId: context.orderId || null,
    replayAttempt: Number.isInteger(context.replayAttempt) ? context.replayAttempt : 1,
    rewind: Boolean(context.rewind)
  };
}

export function clearDirectionLogReplayContext() {
  directionLogReplayContext = null;
}

export const logger = {
  debug: (msg, meta) => log('DEBUG', msg, meta),
  info: (msg, meta) => log('INFO', msg, meta),
  warn: (msg, meta) => log('WARN', msg, meta),
  error: (msg, meta) => log('ERROR', msg, meta),

  subscribe,
  unsubscribe,
  runInSession,
  setDirectionLogReplayContext,
  clearDirectionLogReplayContext,

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
  },

  logRequestFlow: (direction, entry = {}) => {
    logToRequestFlowFile({
      direction,
      ...entry
    });
  },

  logIncoming: (source, destination, api, payload, meta = {}) => {
    const entry = {
      timestamp: formatTimestamp(),
      direction: 'incoming',
      source,
      destination,
      api,
      payload,
      ...meta
    };
    logToDirectionFile('incoming', entry);
    logToRequestFlowFile(entry);
  },

  logOutgoing: (source, destination, api, payload, meta = {}) => {
    const normalizedMeta = {
      ...meta,
      entryIndex:
        meta.entryIndex ??
        (typeof meta.logIndex === 'number' ? meta.logIndex : null)
    };
    const entry = prioritizeDirectionLogFields({
      timestamp: formatTimestamp(),
      direction: 'outgoing',
      source,
      destination,
      api,
      payload,
      ...normalizedMeta
    });
    logToDirectionFile('outgoing', entry);
    logToRequestFlowFile(entry);
  },

  logFinalIncoming: (source, destination, api, payload, meta = {}) => {
    const entry = {
      timestamp: formatTimestamp(),
      direction: 'incoming',
      event: 'received',
      source,
      destination,
      api,
      payload,
      ...meta
    };
    logToDirectionFile('incoming', entry);
    logToRequestFlowFile(entry);
  },

  logFinalOutgoing: (source, destination, api, payload, meta = {}) => {
    const normalizedMeta = {
      ...meta,
      entryIndex:
        meta.entryIndex ??
        (typeof meta.logIndex === 'number' ? meta.logIndex : null)
    };
    const entry = prioritizeDirectionLogFields({
      timestamp: formatTimestamp(),
      direction: 'outgoing',
      event: 'forwarded',
      source,
      destination,
      api,
      payload,
      ...normalizedMeta
    });
    logToDirectionFile('outgoing', entry);
    logToRequestFlowFile(entry);
  }
};

export default logger;
