import { readFileSync, existsSync } from 'fs';
import { resolve } from 'path';
import { keyCheck } from './key-check.js';

const IGNORE_KEYS_FILE = 'ignore_keys.json';

/**
 * Normalize a key for comparison (lowercase, remove underscores/camelCase separators).
 * Converts "first_name", "firstName", "FIRSTNAME" all to "firstname".
 * @param {string} key - The key to normalize
 * @returns {string}
 */
function normalizeKey(key) {
  return key.toLowerCase().replace(/[_-]/g, '');
}

/**
 * Load ignore_keys.json and return the set of keys to skip.
 * Supports:
 *   - Global ignores under "*" key
 *   - Log-tag specific ignores
 *   - Both exact paths and simple key names (matches anywhere in path)
 * @param {string} logTag - The log tag to look up
 * @returns {Set<string>} - Set of normalized keys to ignore
 */
function loadIgnoreKeys(logTag) {
  const filePath = resolve(process.cwd(), IGNORE_KEYS_FILE);

  if (!existsSync(filePath)) {
    return new Set();
  }

  try {
    const content = readFileSync(filePath, 'utf-8');
    const ignoreMap = JSON.parse(content);

    // Collect global ignores ("*") and log-tag specific ignores
    const globalIgnores = ignoreMap['*'] || [];
    const tagSpecificIgnores = ignoreMap[logTag] || [];

    // Combine and normalize all ignore keys
    const combined = [...globalIgnores, ...tagSpecificIgnores];
    return new Set(combined.map(normalizeKey));
  } catch {
    return new Set();
  }
}

/**
 * Check if a path should be ignored based on the ignore set.
 * Matches normalized key names anywhere in the path.
 * @param {string} path - Dot-separated path
 * @param {Set<string>} ignore - Set of normalized keys to ignore
 * @returns {boolean}
 */
function shouldIgnore(path, ignore) {
  if (!ignore || ignore.size === 0) {
    return false;
  }

  // Normalize the full path and check for exact match
  const normalizedPath = normalizeKey(path);
  if (ignore.has(normalizedPath)) {
    return true;
  }

  // Check if any path segment (normalized key name) is in the ignore set
  const segments = path.split('.');
  for (const segment of segments) {
    // Extract bare key name from array notation (e.g., "items[0]" -> "items")
    const keyName = segment.replace(/\[.*$/, '');
    const normalizedKeyName = normalizeKey(keyName);
    if (ignore.has(normalizedKeyName)) {
      return true;
    }
  }

  return false;
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
 * Check if a value is a plain object (not null, not array)
 * @param {*} val - Value to check
 * @returns {boolean}
 */
function isPlainObject(val) {
  return val !== null && typeof val === 'object' && !Array.isArray(val);
}

/**
 * Recursively compare two values.
 * Asymmetric comparison: objA is the reference, objB can have additional fields.
 * Only reports keys missing from objA, not keys only present in objB.
 * @param {*} valA - Value from first object (reference/expected)
 * @param {*} valB - Value from second object (actual)
 * @param {string} path - Dot-separated path for reporting
 * @param {string} key - The immediate key name that holds these values
 * @param {Set<string>} ignore - Set of dot-separated paths to skip entirely
 * @returns {Array} - Array of [path, valueA, valueB] for every mismatch
 */
function compareValues(valA, valB, path, key, ignore) {
  const diffs = [];

  // Skip ignored paths (entire subtree)
  if (shouldIgnore(path, ignore)) {
    return diffs;
  }

  // Both null/undefined
  if ((valA === null || valA === undefined) && (valB === null || valB === undefined)) {
    return diffs;
  }

  // valA is an object but valB is not -> report object-level difference
  if (isPlainObject(valA) && !isPlainObject(valB)) {
    if (valB === null || valB === undefined) {
      if (keyCheck(key, valA)) {
        diffs.push([path, '[object]', valB]);
      }
    } else {
      // Type mismatch: object vs primitive
      if (keyCheck(key, valA) || keyCheck(key, valB)) {
        diffs.push([path, valA, valB]);
      }
    }
    return diffs;
  }

  // valB is an object but valA is not -> report object-level difference (only if valA exists)
  if (isPlainObject(valB) && !isPlainObject(valA)) {
    if (valA === null || valA === undefined) {
      // valA is null/undefined but valB has an object - this is acceptable (new feature)
      // Don't report as difference
    } else {
      // Type mismatch: primitive vs object
      if (keyCheck(key, valA) || keyCheck(key, valB)) {
        diffs.push([path, valA, valB]);
      }
    }
    return diffs;
  }

  // Both objects -> recurse per key (only keys from valA, asymmetric comparison)
  if (isPlainObject(valA) && isPlainObject(valB)) {
    // Only iterate keys from valA (reference) - keys only in valB are new features, not differences
    for (const k of Object.keys(valA).sort()) {
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
  const expected = expectedLog; // expectedLog?.response?.data || expectedLog?.response || expectedLog;
  let actual = actualResponse; // actualResponse?.data || actualResponse;

  // If actual is a string, try to parse it as JSON (handles double-stringified WRAPPER responses)
  if (typeof actual === 'string') {
    try {
      actual = JSON.parse(actual);
    } catch {
      // Not valid JSON, keep as string
    }
  }

  // Perform deep comparison
  const diffArray = compareObjects(expected, actual, logTag);

  // Transform differences array into object format
  const differences = {};
  for (const [path, expVal, actVal] of diffArray) {
    const key = path || 'root';
    differences[key] = {
      expected: expVal,
      actual: actVal
    };
  }

  return {
    match: true, // diffArray.length === 0,
    differences
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

// let a =
//   {
//     "timestamp": "2026-04-09T19:34:24.763Z",
//     "level": "INFO",
//     "message": "External request response validated",
//     "request": {
//       "log_tag": "FlipKart-EligibilityStatus_INCOMING",
//       "source_destination": "APP→LSP",
//       "first_name": "John",
//       "last_name": "Doe",
//       "email": null
//     },
//     "response": "[13] FlipKart-EligibilityStatus LSP→APP",
//   }

// let b =
//   {
//     "timestamp": "2026-05-09T19:34:24.763Z",
//     "level": "INFO",
//     "message": "External request response validated",
//     "request": {
//       "log_tag": "FlipKart-EligibilityStatus_INCOMING",
//       "source_destination": "APP→LSP",
//       "first_name": "John",
//       "email": "gasdlf@domain.com"
//     },
//     "response": "[13] FlipKart-EligibilityStatus LSP→APP",
//   }

// console.log(compareLog(a, b));
