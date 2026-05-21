import { readFileSync, existsSync } from 'fs';
import { resolve } from 'path';

const IGNORE_KEYS_FILE = 'ignore_keys.json';
const STRICT_PAYLOAD_MATCH = process.env.STRICT_PAYLOAD_MATCH === 'true';

function normalizeKey(key) {
  return key.toLowerCase().replace(/[_-]/g, '');
}

function loadIgnoreKeys(logTag) {
  const filePath = resolve(process.cwd(), IGNORE_KEYS_FILE);
  if (!existsSync(filePath)) return new Set();
  try {
    const content = readFileSync(filePath, 'utf-8');
    const ignoreMap = JSON.parse(content);
    const combined = [...(ignoreMap['*'] || []), ...(ignoreMap[logTag] || [])];
    return new Set(combined.map(normalizeKey));
  } catch {
    return new Set();
  }
}

function shouldIgnore(path, ignore) {
  if (!ignore || ignore.size === 0) return false;
  const normalizedPath = normalizeKey(path);
  if (ignore.has(normalizedPath)) return true;
  const segments = path.split('.');
  for (const segment of segments) {
    const keyName = segment.replace(/\[.*$/, '');
    if (ignore.has(normalizeKey(keyName))) return true;
  }
  return false;
}

function isMaskedValue(value) {
  if (typeof value !== 'string') return false;
  if (value === 'MASKED') return true;
  if (/^[X*]+/.test(value)) return true;
  if ((value.match(/[X*]/g) || []).length >= 3) return true;
  return false;
}

function isDynamicValue(value) {
  if (typeof value !== 'string') return false;
  if (/^\d{4}-\d{2}-\d{2}T/.test(value)) return true;
  if (/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value)) return true;
  if (/^\d{10,}$/.test(value)) return true;
  return false;
}

function isPlainObject(val) {
  return val !== null && typeof val === 'object' && !Array.isArray(val);
}

function sortKey(item) {
  if (isPlainObject(item)) {
    const comparable = {};
    for (const [k, v] of Object.entries(item)) {
      if (v !== null && typeof v === 'object') continue;
      if (!isDynamicValue(v) && !isMaskedValue(v)) {
        comparable[k] = v;
      }
    }
    return JSON.stringify(comparable, Object.keys(comparable).sort());
  }
  return JSON.stringify(item);
}

function compareValues(valA, valB, path, key, ignore) {
  const diffs = [];

  if (shouldIgnore(path, ignore)) {
    return diffs;
  }

  if ((valA === null || valA === undefined) && (valB === null || valB === undefined)) {
    return diffs;
  }

  if ((valA === null || valA === undefined) && (valB !== null && valB !== undefined)) {
    diffs.push([path, valA, valB, 'expected missing, actual present']);
    return diffs;
  }
  if ((valA !== null && valA !== undefined) && (valB === null || valB === undefined)) {
    diffs.push([path, valA, valB, 'expected present, actual missing']);
    return diffs;
  }

  const typeA = Array.isArray(valA) ? 'array' : typeof valA;
  const typeB = Array.isArray(valB) ? 'array' : typeof valB;
  if (typeA !== typeB) {
    diffs.push([path, valA, valB, `type mismatch: expected ${typeA}, actual ${typeB}`]);
    return diffs;
  }

  if (Array.isArray(valA) && Array.isArray(valB)) {
    const sortedA = [...valA].sort((a, b) => {
      const ka = sortKey(a), kb = sortKey(b);
      return ka < kb ? -1 : ka > kb ? 1 : 0;
    });
    const sortedB = [...valB].sort((a, b) => {
      const ka = sortKey(a), kb = sortKey(b);
      return ka < kb ? -1 : ka > kb ? 1 : 0;
    });
    const maxLen = Math.max(sortedA.length, sortedB.length);
    for (let i = 0; i < maxLen; i++) {
      const childPath = `${path}[${i}]`;
      if (i < sortedA.length && i < sortedB.length) {
        diffs.push(...compareValues(sortedA[i], sortedB[i], childPath, key, ignore));
      } else if (i < sortedA.length) {
        diffs.push([childPath, sortedA[i], '<missing>', 'element missing in actual']);
      } else {
        diffs.push([childPath, '<missing>', sortedB[i], 'extra element in actual']);
      }
    }
    return diffs;
  }

  if (isPlainObject(valA) && isPlainObject(valB)) {
    const keysA = Object.keys(valA).sort();
    const keysB = Object.keys(valB).sort();
    
    for (const k of keysA) {
      const childPath = path ? `${path}.${k}` : k;
      if (!valB.hasOwnProperty(k)) {
        if (!shouldIgnore(childPath, ignore)) {
          diffs.push([childPath, valA[k], '<missing>', 'key missing in actual']);
        }
      }
    }
    
    for (const k of keysB) {
      const childPath = path ? `${path}.${k}` : k;
      if (!valA.hasOwnProperty(k)) {
        if (!shouldIgnore(childPath, ignore)) {
          diffs.push([childPath, '<missing>', valB[k], 'extra key in actual']);
        }
      }
    }
    
    for (const k of keysA) {
      if (valB.hasOwnProperty(k)) {
        const childPath = path ? `${path}.${k}` : k;
        diffs.push(...compareValues(valA[k], valB[k], childPath, k, ignore));
      }
    }
    return diffs;
  }

  if (isMaskedValue(valA) || isMaskedValue(valB)) {
    return diffs;
  }

  if (isDynamicValue(valA) || isDynamicValue(valB)) {
    return diffs;
  }

  if (key && /id$/i.test(key)) {
    return diffs;
  }

  if (valA !== valB) {
    diffs.push([path, valA, valB, 'value mismatch']);
  }

  return diffs;
}

export function compareObjects(objA, objB, logTag) {
  const ignore = loadIgnoreKeys(logTag);
  return compareValues(objA, objB, '', '', ignore);
}

export function compareLog(expectedLog, actualResponse, logTag = '') {
  if (logTag && logTag.includes('_ENCRYPTED')) {
    return {
      match: true,
      differences: {},
      diffSummary: ''
    };
  }

  let expected = expectedLog;
  let actual = actualResponse;

  if (typeof actual === 'string') {
    try {
      actual = JSON.parse(actual);
    } catch {
      // Not valid JSON, keep as string
    }
  }

  const diffArray = compareObjects(expected, actual, logTag);

  const differences = {};
  const diffMessages = [];
  for (const [path, expVal, actVal, reason] of diffArray) {
    const key = path || 'root';
    differences[key] = { expected: expVal, actual: actVal, reason };
    diffMessages.push(`${path}: ${reason} (expected=${JSON.stringify(expVal)}, actual=${JSON.stringify(actVal)})`);
  }

  return {
    match: STRICT_PAYLOAD_MATCH ? diffArray.length === 0 : true,
    differences,
    diffSummary: diffMessages.join('; ')
  };
}

export function findMatchingLog(outputList, logTag, sourceDestination) {
  const index = outputList.findIndex(
    log => log.log_tag === logTag && log.source_destination === sourceDestination
  );
  if (index === -1) return { found: false, log: null, index: -1 };
  return { found: true, log: outputList[index], index };
}

export default {
  compareObjects,
  compareLog,
  findMatchingLog
};
