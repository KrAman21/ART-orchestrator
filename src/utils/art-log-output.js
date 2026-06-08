import { appendFileSync, mkdirSync, writeFileSync } from 'fs';
import { dirname, resolve } from 'path';

const ENABLED = process.env.ART_SANITIZE_LOGS !== 'false' && (
  process.env.ART_SANITIZE_LOGS === 'true' ||
  process.env.PROCESS_COMPOSE_STOP_ENABLED === 'true' ||
  Boolean(process.env.PROCESS_COMPOSE_SOCKET || process.env.ART_USER_LOG_PATH || process.env.ART_DEBUG_LOG_PATH)
);
const ECHO_STDOUT = process.env.ART_ECHO_STDOUT === 'true';
const REPORT_START = 'ART Report Content Start';
const REPORT_END = 'ART Report Content End';
const ANSI_PATTERN = /\x1b\[[0-9;]*m/g;

const USER_PREFIXES = [
  'Sequential ART Runner',
  'Concurrent ART Runner',
  'Total Orders:',
  'Using Explicit ORDER_LIST',
  'Fetching Order IDs from QAPI',
  'Fetched ',
  'Limited to first ',
  'Playing Order ',
  'Merchant: ',
  'Order ',
  'Failed to process order ',
  'Sequential Processing Complete',
  'Concurrent Processing Complete',
  'Successful:',
  'Failed:',
  'Total:',
  'Sequential ART Complete',
  'Overall Success:',
  'ART Report Path:',
  'ART Report generated:',
  'ART HTML Report generated:',
  'ART Report Server listening',
  'HTML Report: http://',
  'ART REPORT SUMMARY',
  'Stopping process-compose services',
  'No order IDs found from QAPI',
  'Failed to start:',
  'Unhandled promise rejection',
  'Uncaught exception',
  'Warning:'
];

const USER_MARKERS = [
  '🧾',
  '🟢',
  '🔴',
  '✅',
  '❌',
  '🟡',
  '📄',
  '📊',
  '🔎',
  '⚠️',
  '🌐'
];

let reportMode = false;

function resolveDefaultLogPath(envPath, fileName) {
  if (envPath) {
    return resolve(process.cwd(), envPath);
  }

  if (process.env.REPORT_PATH) {
    return resolve(dirname(resolve(process.cwd(), process.env.REPORT_PATH)), fileName);
  }

  return resolve(process.env.PWD || process.cwd(), 'logs', fileName);
}

const USER_LOG_PATH = resolveDefaultLogPath(process.env.ART_USER_LOG_PATH, 'art.log');
const DEBUG_LOG_PATH = resolveDefaultLogPath(process.env.ART_DEBUG_LOG_PATH, 'art-debugger.log');

function ensureLogFile(filePath) {
  mkdirSync(dirname(filePath), { recursive: true });
  writeFileSync(filePath, '', { encoding: 'utf-8' });
}

function appendLine(filePath, line) {
  appendFileSync(filePath, `${line}\n`, { encoding: 'utf-8' });
}

function stringifyArg(arg) {
  if (typeof arg === 'string') return arg;
  if (arg instanceof Error) return arg.stack || arg.message;

  try {
    return JSON.stringify(arg);
  } catch {
    return String(arg);
  }
}

function unwrapLogMessage(line) {
  if (!line.startsWith('{') || !line.includes('"message"')) return line;

  try {
    const entry = JSON.parse(line);
    const message = entry?.message;
    if (typeof message !== 'string') return null;

    if (message.startsWith('{') && message.includes('"message"')) {
      try {
        const nested = JSON.parse(message);
        if (typeof nested?.message === 'string') return nested.message;
      } catch {
        return message;
      }
    }

    return message;
  } catch {
    return line;
  }
}

function sanitizeLine(rawLine) {
  const line = unwrapLogMessage(rawLine.trimEnd());
  if (line === null) return [];
  const visibleLine = line.replace(ANSI_PATTERN, '');

  if (visibleLine === REPORT_START) {
    reportMode = true;
    return [visibleLine];
  }

  if (reportMode) {
    if (visibleLine === REPORT_END) reportMode = false;
    return [visibleLine];
  }

  if (!visibleLine || visibleLine === '========================================') return [];

  if (visibleLine.startsWith('ART_PROGRESS: ')) {
    return [visibleLine.replace(/^ART_PROGRESS: /, '')];
  }

  if (
    USER_PREFIXES.some((prefix) => visibleLine.startsWith(prefix)) ||
    USER_MARKERS.some((marker) => visibleLine.startsWith(marker))
  ) {
    return [visibleLine];
  }

  return [];
}

function writeLogs(args) {
  const rawMessage = args.map(stringifyArg).join(' ');
  const rawLines = rawMessage.split(/\r?\n/);

  for (const rawLine of rawLines) {
    appendLine(DEBUG_LOG_PATH, rawLine);

    for (const userLine of sanitizeLine(rawLine)) {
      appendLine(USER_LOG_PATH, userLine);
    }
  }
}

export function installArtLogOutput() {
  if (!ENABLED || global.__art_log_output_installed__) return;

  const originalConsole = {
    log: console.log.bind(console),
    warn: console.warn.bind(console),
    error: console.error.bind(console)
  };

  try {
    ensureLogFile(DEBUG_LOG_PATH);
    ensureLogFile(USER_LOG_PATH);
  } catch (error) {
    originalConsole.error(`[ART_LOG_OUTPUT] Failed to initialize log files: ${error.message}`);
    return;
  }

  for (const method of ['log', 'warn', 'error']) {
    console[method] = (...args) => {
      try {
        writeLogs(args);
      } catch (error) {
        originalConsole.error(`[ART_LOG_OUTPUT] Failed: ${error.message}`);
      }

      if (ECHO_STDOUT) {
        originalConsole[method](...args);
      }
    };
  }

  global.__art_log_output_installed__ = true;
}

installArtLogOutput();
