/**
 * Simple structured logger for ART Orchestrator
 * Logs to both console and file (art-orchestrator.log)
 */

import { appendFileSync, mkdirSync, writeFileSync } from 'fs';
import { dirname, resolve } from 'path';

const LOG_LEVELS = {
  DEBUG: 0,
  INFO: 1,
  WARN: 2,
  ERROR: 3
};

const CURRENT_LEVEL = LOG_LEVELS[process.env.LOG_LEVEL?.toUpperCase()] ?? LOG_LEVELS.INFO;
const LOG_FILE = process.env.LOG_FILE || 'art-orchestrator.log';
const LOG_TO_FILE = process.env.LOG_TO_FILE !== 'false'; // Default to true

// Resolve log file path relative to cwd
const LOG_FILE_PATH = resolve(process.cwd(), LOG_FILE);

// Ensure log directory exists and clear previous log
if (LOG_TO_FILE) {
  try {
    mkdirSync(dirname(LOG_FILE_PATH), { recursive: true });
    // Clear previous log file on startup
    writeFileSync(LOG_FILE_PATH, '', { encoding: 'utf-8' });
  } catch (error) {
    // Directory might already exist or other error - continue
  }
}

function formatTimestamp() {
  return new Date().toISOString();
}

function logToFile(logEntry) {
  if (!LOG_TO_FILE) return;

  try {
    const line = JSON.stringify(logEntry) + '\n';
    appendFileSync(LOG_FILE_PATH, line, { encoding: 'utf-8' });
  } catch (error) {
    // Silently fail file logging - don't break the app
    // Console output still happens
  }
}

function log(level, message, meta = {}) {
  if (LOG_LEVELS[level] < CURRENT_LEVEL) return;

  const logEntry = {
    timestamp: formatTimestamp(),
    level,
    message,
    ...meta
  };

  const line = JSON.stringify(logEntry);

  // Console output
  if (level === 'ERROR') {
    console.error(line);
  } else if (level === 'WARN') {
    console.warn(line);
  } else {
    console.log(line);
  }

  // File output
  logToFile(logEntry);
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
