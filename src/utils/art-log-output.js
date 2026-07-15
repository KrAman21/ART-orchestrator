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
  'ART PDF Report generated:',
  'ART Report Server listening',
  'PDF Report:',
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
const FETCH_LOG_PATH = resolveDefaultLogPath(process.env.ART_FETCH_LOG_PATH, 'art-fetch.log');

const FETCH_PREFIXES = [
  '[PREFETCH]',
  'Fetching replay logs for order:',
  'Resolving order context from local LSP proxy endpoint',
  'Resolved order context from local LSP proxy endpoint',
  'Fetching S3 Trace Logs',
  'Successfully fetched S3 Trace Logs',
  'Filtered out non-replayable logs from S3 Trace Logs',
  'Successfully fetched combined replay logs for order',
  'Removed out-of-context logs from merged replay logs',
  'Saved filtered logs to:',
  'Saved final filtered logs to:',
  'Saved ',
  'Loaded ',
  'Filtered logs:',
  'Removed ',
  'Sample logs removed:',
  'Sample duplicates removed:',
  'Fetching Order IDs from QAPI',
  'Fetched ',
  'Replay artifacts for ',
  'Raw logs: ',
  'Filtered logs: ',
  'Final filtered logs: ',
  'Deleted order temp files',
  'Log fetch attempt ',
  'No logs found after ',
  'No logs to process after fetch',
  'No logs remaining after filterAndSortLogs',
  'No logs remaining after filterOrchestratorSkippableLogs'
];

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

function classifyLine(rawLine) {
  const line = unwrapLogMessage(rawLine.trimEnd());
  if (line === null) return { user: [], fetch: [] };
  const visibleLine = line.replace(ANSI_PATTERN, '');

  if (visibleLine === REPORT_START) {
    reportMode = true;
    return { user: [visibleLine], fetch: [] };
  }

  if (reportMode) {
    if (visibleLine === REPORT_END) reportMode = false;
    return { user: [visibleLine], fetch: [] };
  }

  if (!visibleLine || visibleLine === '========================================') {
    return { user: [], fetch: [] };
  }

  if (FETCH_PREFIXES.some((prefix) => visibleLine.startsWith(prefix))) {
    return { user: [], fetch: [visibleLine] };
  }

  if (visibleLine.startsWith('ART_PROGRESS: ')) {
    const progressLine = visibleLine.replace(/^ART_PROGRESS: /, '');
    if (progressLine.includes('Step 1: Fetching logs') || progressLine.includes('Step 2: Loading and filtering logs')) {
      return { user: [], fetch: [progressLine] };
    }
    return { user: [progressLine], fetch: [] };
  }

  if (
    USER_PREFIXES.some((prefix) => visibleLine.startsWith(prefix)) ||
    USER_MARKERS.some((marker) => visibleLine.startsWith(marker))
  ) {
    return { user: [visibleLine], fetch: [] };
  }

  return { user: [], fetch: [] };
}

function writeLogs(args) {
  const rawMessage = args.map(stringifyArg).join(' ');
  const rawLines = rawMessage.split(/\r?\n/);

  for (const rawLine of rawLines) {
    appendLine(DEBUG_LOG_PATH, rawLine);

    const { user, fetch } = classifyLine(rawLine);

    for (const userLine of user) {
      appendLine(USER_LOG_PATH, userLine);
    }

    for (const fetchLine of fetch) {
      appendLine(FETCH_LOG_PATH, fetchLine);
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
    ensureLogFile(FETCH_LOG_PATH);
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
