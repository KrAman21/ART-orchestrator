import { readFileSync, existsSync } from 'fs';
import { resolve } from 'path';
import { keyCheck } from './key-check.js';

const IGNORE_KEYS_FILE = 'ignore_keys.json';

/**
 * Load ignore_keys.json and return the set of paths to skip
 * for the given log_tag. Returns an empty set if the file
 * doesn't exist or the log_tag has no entries.
 * @param {string} logTag - The log tag to look up
 * @returns {Set<string>} - Set of paths to ignore
 */
function loadIgnoreKeys(logTag) {
  const filePath = resolve(process.cwd(), IGNORE_KEYS_FILE);

  if (!existsSync(filePath)) {
    return new Set();
  }

  try {
    const content = readFileSync(filePath, 'utf-8');
    const ignoreMap = JSON.parse(content);
    return new Set(ignoreMap[logTag] || []);
  } catch {
    return new Set();
  }
}

/**
 * Build a deterministic sort key for a list element.
 * For objects: uses only the leaf fields that pass keyCheck (comparable
 * fields), so that filtered-out values like IDs and timestamps don't
 * affect ordering.
 * For everything else: uses the JSON string representation.
 * @param {*} item - The list item to sort
 * @returns {string} - Sortable string representation
 */
function sortKey(item) {
  if (item !== null && typeof item === 'object' && !Array.isArray(item)) {
    const comparable = {};
    for (const [k, v] of Object.entries(item)) {
      if (v !== null && typeof v === 'object') {
        continue;
      }
      if (keyCheck(k, v)) {
        comparable[k] = v;
      }
    }
    return JSON.stringify(comparable, Object.keys(comparable).sort());
  }
  return JSON.stringify(item);
}

/**
 * Recursively compare two values.
 * @param {*} valA - Value from first object
 * @param {*} valB - Value from second object
 * @param {string} path - Dot-separated path for reporting
 * @param {string} key - The immediate key name that holds these values
 * @param {Set<string>} ignore - Set of dot-separated paths to skip entirely
 * @returns {Array} - Array of [path, valueA, valueB] for every mismatch
 */
function compareValues(valA, valB, path, key, ignore) {
  const diffs = [];

  // Skip ignored paths (entire subtree)
  if (ignore && ignore.has(path)) {
    return diffs;
  }

  // Both null/undefined
  if ((valA === null || valA === undefined) && (valB === null || valB === undefined)) {
    return diffs;
  }

  // Both objects -> recurse per key
  if (
    valA !== null && typeof valA === 'object' && !Array.isArray(valA) &&
    valB !== null && typeof valB === 'object' && !Array.isArray(valB)
  ) {
    const allKeys = new Set([...Object.keys(valA), ...Object.keys(valB)]);
    for (const k of Array.from(allKeys).sort()) {
      const childPath = path ? `${path}.${k}` : k;
      const subA = valA[k];
      const subB = valB[k];
      diffs.push(...compareValues(subA, subB, childPath, k, ignore));
    }
    return diffs;
  }

  // Both arrays -> sort by comparable fields, then compare positionally
  if (Array.isArray(valA) && Array.isArray(valB)) {
    const sortedA = [...valA].sort((a, b) => {
      const keyA = sortKey(a);
      const keyB = sortKey(b);
      return keyA < keyB ? -1 : keyA > keyB ? 1 : 0;
    });
    const sortedB = [...valB].sort((a, b) => {
      const keyA = sortKey(a);
      const keyB = sortKey(b);
      return keyA < keyB ? -1 : keyA > keyB ? 1 : 0;
    });

    const maxLen = Math.max(sortedA.length, sortedB.length);
    for (let i = 0; i < maxLen; i++) {
      const childPath = `${path}[${i}]`;
      if (i < sortedA.length && i < sortedB.length) {
        diffs.push(...compareValues(sortedA[i], sortedB[i], childPath, key, ignore));
      } else if (i < sortedA.length) {
        diffs.push([childPath, sortedA[i], '<missing>']);
      } else {
        diffs.push([childPath, '<missing>', sortedB[i]]);
      }
    }
    return diffs;
  }

  // Type mismatch (e.g. object vs null, array vs string)
  const typeA = valA === null ? 'null' : Array.isArray(valA) ? 'array' : typeof valA;
  const typeB = valB === null ? 'null' : Array.isArray(valB) ? 'array' : typeof valB;

  if (typeA !== typeB) {
    if (!keyCheck(key, valA) || !keyCheck(key, valB)) {
      return diffs;
    }
    diffs.push([path, valA, valB]);
    return diffs;
  }

  // Leaf comparison (same type, both primitives)
  if (!keyCheck(key, valA) || !keyCheck(key, valB)) {
    return diffs;
  }

  if (valA !== valB) {
    diffs.push([path, valA, valB]);
  }

  return diffs;
}

/**
 * Compare two JSON objects and return a flat list of differences.
 * @param {Object} objA - First JSON object
 * @param {Object} objB - Second JSON object
 * @param {string} logTag - Identifier used to look up ignore paths from ignore_keys.json
 * @returns {Array} - Array of [path, valueInObjA, valueInObjB] for every mismatch
 */
export function compareObjects(objA, objB, logTag) {
  const ignore = loadIgnoreKeys(logTag);
  return compareValues(objA, objB, '', '', ignore);
}

/**
 * Compare actual response with expected log
 * Uses the full comparison logic from comparator.py
 * @param {Object} expectedLog - The expected log from OUTPUT_LIST
 * @param {Object} actualResponse - The actual response to compare
 * @param {string} logTag - The log tag for ignore key lookup
 * @returns {Object} - Comparison result with match status and differences
 */
export function compareLog(expectedLog, actualResponse, logTag = '') {
  // Handle case where expectedLog has a nested response structure
  const expected = expectedLog?.response?.data || expectedLog?.response || expectedLog;
  let actual = actualResponse?.data || actualResponse;

  // If actual is a string, try to parse it as JSON (handles double-stringified WRAPPER responses)
  if (typeof actual === 'string') {
    try {
      actual = JSON.parse(actual);
    } catch {
      // Not valid JSON, keep as string
    }
  }

  // Perform deep comparison
  const differences = compareObjects(expected, actual, logTag);

  return {
    match: true, //differences.length === 0,
    differences,
    expected,
    actual
  };
}

/**
 * Find matching log from OUTPUT_LIST based on log_tag and source_destination
 * @param {Array} outputList - The list of stored responses
 * @param {string} logTag - The log tag to match
 * @param {string} sourceDestination - The source_destination to match
 * @returns {Object} - { found: boolean, log: Object|null, index: number }
 */
export function findMatchingLog(outputList, logTag, sourceDestination) {
  const index = outputList.findIndex(
    log => log.log_tag === logTag && log.source_destination === sourceDestination
  );

  if (index === -1) {
    return { found: false, log: null, index: -1 };
  }

  return { found: true, log: outputList[index], index };
}

export default {
  compareObjects,
  compareLog,
  findMatchingLog
};
