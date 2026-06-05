import { readFileSync, existsSync } from 'fs';
import { resolve } from 'path';

const IGNORE_KEYS_FILE = 'ignore_keys.json';
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
  const segments = path.split('.');
  for (const segment of segments) {
    const keyName = segment.replace(/\[.*$/, '');
    const normalizedKeyName = normalizeKey(keyName);
    if (normalizedKeyName.endsWith('id')) return true;
    if (normalizedKeyName.endsWith('expiryat')) return true;
  }
  if (!ignore || ignore.size === 0) return false;
  const normalizedPath = normalizeKey(path);
  if (ignore.has(normalizedPath)) return true;
  for (const segment of segments) {
    const keyName = segment.replace(/\[.*$/, '');
    const normalizedKeyName = normalizeKey(keyName);
    if (ignore.has(normalizedKeyName)) return true;
  }
  return false;
}

function isPlainObject(val) {
  return val !== null && typeof val === 'object' && !Array.isArray(val);
}

function isMaskedValue(value) {
  if (typeof value !== 'string') return false;
  if (value === 'MASKED') return true;
  if (/^[X*]+$/.test(value)) return true;
  return (value.match(/[X*]/g) || []).length >= 3;
}

function sortKey(item) {
  if (isPlainObject(item)) {
    const comparable = {};
    for (const [k, v] of Object.entries(item)) {
      if (v !== null && typeof v === 'object') continue;
      comparable[k] = v;
    }
    return JSON.stringify(comparable, Object.keys(comparable).sort());
  }
  return JSON.stringify(item);
}

function compareLenderOrgIds(expectedIds, actualIds, path) {
  const expectedList = Array.isArray(expectedIds) ? expectedIds : [];
  const actualList = Array.isArray(actualIds) ? actualIds : [];
  const expectedSet = new Set(expectedList);
  const actualSet = new Set(actualList);
  const missingInActual = expectedList.filter(id => !actualSet.has(id));
  const extraInActual = actualList.filter(id => !expectedSet.has(id));

  if (missingInActual.length === 0 && extraInActual.length === 0) {
    return [];
  }

  const reasonParts = [];
  if (missingInActual.length > 0) {
    reasonParts.push(`missing in actual: ${JSON.stringify(missingInActual)}`);
  }
  if (extraInActual.length > 0) {
    reasonParts.push(`extra in actual: ${JSON.stringify(extraInActual)}`);
  }

  return [[path, expectedList, actualList, reasonParts.join('; ')]];
}

function getLenderEligibilityKey(item) {
  if (!isPlainObject(item)) return null;
  return item.lender_code || item.lenderCode || item.lenderOrgId || item.lender_org_id || null;
}

function compareArrayObjectsByKey(expectedItems, actualItems, path, ignore, logTag, getKey) {
  const diffs = [];
  const expectedList = Array.isArray(expectedItems) ? expectedItems : [];
  const actualList = Array.isArray(actualItems) ? actualItems : [];
  const expectedMap = new Map(expectedList.map(item => [getKey(item), item]).filter(([key]) => key));
  const actualMap = new Map(actualList.map(item => [getKey(item), item]).filter(([key]) => key));

  if (expectedMap.size !== expectedList.length || actualMap.size !== actualList.length) {
    return null;
  }

  const allKeys = Array.from(new Set([...expectedMap.keys(), ...actualMap.keys()])).sort();

  for (const key of allKeys) {
    const childPath = `${path}[${key}]`;
    if (!actualMap.has(key)) {
      diffs.push([childPath, expectedMap.get(key), '<missing>', 'element missing in actual']);
      continue;
    }
    if (!expectedMap.has(key)) {
      diffs.push([childPath, '<missing>', actualMap.get(key), 'extra element in actual']);
      continue;
    }

    diffs.push(...compareValues(expectedMap.get(key), actualMap.get(key), childPath, ignore, logTag));
  }

  return diffs;
}

function compareValues(valA, valB, path, ignore, logTag) {
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

  if (logTag === 'LSP-Eligibility_REQUEST' && normalizeKey(path) === 'lenderorgids' && Array.isArray(valA) && Array.isArray(valB)) {
    return compareLenderOrgIds(valA, valB, path);
  }

  if (
    logTag === 'FlipKart-EligibilityStatus_RESPONSE' &&
    normalizeKey(path) === 'lendereligibilities' &&
    Array.isArray(valA) &&
    Array.isArray(valB)
  ) {
    const lenderWiseDiffs = compareArrayObjectsByKey(valA, valB, path, ignore, logTag, getLenderEligibilityKey);
    if (lenderWiseDiffs) {
      return lenderWiseDiffs;
    }
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
        diffs.push(...compareValues(sortedA[i], sortedB[i], childPath, ignore, logTag));
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
        diffs.push(...compareValues(valA[k], valB[k], childPath, ignore, logTag));
      }
    }
    return diffs;
  }

  if (isMaskedValue(valA) || isMaskedValue(valB)) {
    return diffs;
  }

  if (valA !== valB) {
    diffs.push([path, valA, valB, 'value mismatch']);
  }

  return diffs;
}

export function compareObjects(objA, objB, logTag) {
  const ignore = loadIgnoreKeys(logTag);
  return compareValues(objA, objB, '', ignore, logTag);
}

export function compareLog(expectedLog, actualResponse, logTag = '') {
  if (logTag && logTag.includes('_ENCRYPTED')) {
    return {
      match: true,
      differences: {},
      differenceList: []
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
  const differenceList = [];
  for (const [path, expVal, actVal, reason] of diffArray) {
    const key = path || 'root';
    differences[key] = { expected: expVal, actual: actVal, reason };
    differenceList.push({
      path: key,
      expected: expVal,
      actual: actVal,
      reason
    });
  }

  return {
    match: diffArray.length === 0,
    differences,
    differenceList
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
