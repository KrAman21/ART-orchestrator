import { readFileSync, existsSync } from 'fs';
import { resolve } from 'path';

const IGNORE_KEYS_FILE = 'ignore_keys.json';

function normalizeKey(key) {
  return key.toLowerCase().replace(/[_-]/g, '');
}

function normalizePathForRule(path) {
  return normalizeKey(String(path || '').replace(/\[\d+\]/g, '').replace(/[^a-zA-Z0-9]/g, ''));
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
    if (normalizedKeyName.includes('time')) return true;
    if (normalizedKeyName.includes('date')) return true;
    if (normalizedKeyName.includes('timestamp')) return true;
    if (normalizedKeyName.includes('expiry')) return true;
    if (normalizedKeyName.includes('validtill')) return true;
    if (normalizedKeyName === 'ip') return true;
    if (normalizedKeyName === 'sessiontoken') return true;
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

function unwrapComparableEnvelope(expected, actual) {
  if (!isPlainObject(expected) || !isPlainObject(actual)) {
    return { expected, actual };
  }

  const expectedHasPayload = Object.prototype.hasOwnProperty.call(expected, 'payload') && isPlainObject(expected.payload);
  const actualHasPayload = Object.prototype.hasOwnProperty.call(actual, 'payload') && isPlainObject(actual.payload);

  if (!expectedHasPayload && actualHasPayload) {
    return { expected, actual: actual.payload };
  }

  if (expectedHasPayload && !actualHasPayload) {
    return { expected: expected.payload, actual };
  }

  return { expected, actual };
}

function isMaskedValue(value) {
  if (typeof value !== 'string') return false;
  if (value === 'MASKED') return true;
  if (value.startsWith('XX')) return true;
  if (/^[X*]+$/.test(value)) return true;
  return (value.match(/[X*]/g) || []).length >= 3;
}

function isBlankString(value) {
  return typeof value === 'string' && value.trim() === '';
}

function isBlankEquivalentString(value) {
  if (typeof value !== 'string') return false;
  const normalized = value.trim().toUpperCase();
  return normalized === '' || normalized === 'NA' || normalized === 'N/A';
}

function shouldSkipComparison(path, valA, valB, ignore) {
  if (shouldIgnore(path, ignore)) {
    return true;
  }

  if (isMaskedValue(valA) || isMaskedValue(valB)) {
    return true;
  }

  return false;
}

const REPLAY_ENRICHMENT_TOLERANCE_RULES = {
  'LSP-Eligibility_REQUEST': new Set([
    'applicantproductdata',
    'applicantsproductdata',
    'applicantbusinessdetailsmonthlyincome',
    'applicantsbusinessdetailsmonthlyincome',
    'borrowerbusinessdetailsmonthlyincome',
    'borrowerbusinessdetailsentitycategory',
    'borrowerprofiledetails',
    'borrowerprofiledetailsaddresstype'
  ]),
  'Themis-Eligibility_REQUEST': new Set([
    'applicantproductdata',
    'borrowerbusinessdetailsentitycategory',
    'borrowerprofiledetails',
    'borrowerprofiledetailsaddresstype'
  ]),
  'LSP-FetchOfferRequest_REQUEST': new Set([
    'loanapplicationapplicantsproductdata',
    'loanapplicationapplicantsbusinessdetailsmonthlyincome',
    'loanapplicationborrowerorganizationdetails',
    'loanapplicationborrowerbusinessdetailsmonthlyincome',
    'loanapplicationborrowerbusinessdetailsentitycategory',
    'loanapplicationborrowerprofiledetails',
    'loanapplicationborrowerprofiledetailsaddresstype'
  ])
};

function shouldSkipReplayEnrichmentDifference(path, valA, valB, logTag) {
  const toleratedPaths = REPLAY_ENRICHMENT_TOLERANCE_RULES[logTag];
  if (!toleratedPaths) {
    return false;
  }

  const normalizedPath = normalizePathForRule(path);

  if (!toleratedPaths.has(normalizedPath)) {
    return false;
  }

  const hasNullishSide = valA === null || valA === undefined || valB === null || valB === undefined;
  const hasMissingMarker = valA === '<missing>' || valB === '<missing>';

  return hasNullishSide || hasMissingMarker || valA !== valB;
}

function getNumericStringType(value) {
  if (typeof value !== 'string') return null;

  const trimmed = value.trim();
  if (!trimmed) return null;

  if (!/^[+-]?\d+(\.\d+)?$/.test(trimmed)) {
    return null;
  }

  if (trimmed.includes('.')) {
    return 'DOUBLE';
  }

  try {
    const asBigInt = BigInt(trimmed);
    const intMin = BigInt(-2147483648);
    const intMax = BigInt(2147483647);
    return asBigInt >= intMin && asBigInt <= intMax ? 'INTEGER' : 'LONG';
  } catch {
    return null;
  }
}

function getValueType(value) {
  if (value === null || value === undefined) return 'NULL';
  if (Array.isArray(value)) return 'ARRAY';
  if (typeof value === 'string') return getNumericStringType(value) || 'STRING';
  if (typeof value === 'boolean') return 'BOOLEAN';
  if (typeof value === 'number') {
    if (Number.isInteger(value)) {
      return value >= -2147483648 && value <= 2147483647 ? 'INTEGER' : 'LONG';
    }
    return 'DOUBLE';
  }
  if (typeof value === 'object') return 'OBJECT';
  return 'STRING';
}

function isNumericType(type) {
  return ['INTEGER', 'LONG', 'FLOAT', 'DOUBLE', 'DECIMAL'].includes(type);
}

function isDecimalLikeType(type) {
  return ['FLOAT', 'DOUBLE', 'DECIMAL'].includes(type);
}

function makeDiff(path, expected, actual, reason, extra = {}) {
  return {
    path,
    expected,
    actual,
    reason,
    ...extra
  };
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

  return [makeDiff(path, expectedList, actualList, reasonParts.join('; '))];
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
      diffs.push(makeDiff(childPath, expectedMap.get(key), '<missing>', 'element missing in actual'));
      continue;
    }
    if (!expectedMap.has(key)) {
      diffs.push(makeDiff(childPath, '<missing>', actualMap.get(key), 'extra element in actual'));
      continue;
    }

    diffs.push(...compareValues(expectedMap.get(key), actualMap.get(key), childPath, ignore, logTag));
  }

  return diffs;
}

function compareValues(valA, valB, path, ignore, logTag) {
  const diffs = [];

  if (shouldSkipComparison(path, valA, valB, ignore)) {
    return diffs;
  }

  if ((valA === null || valA === undefined) && (valB === null || valB === undefined)) {
    return diffs;
  }

  if ((valA === null || valA === undefined) && (valB !== null && valB !== undefined)) {
    if (!shouldSkipReplayEnrichmentDifference(path, valA, valB, logTag)) {
      diffs.push(makeDiff(path, valA, valB, 'expected missing, actual present'));
    }
    return diffs;
  }
  if ((valA !== null && valA !== undefined) && (valB === null || valB === undefined)) {
    if (!shouldSkipReplayEnrichmentDifference(path, valA, valB, logTag)) {
      diffs.push(makeDiff(path, valA, valB, 'expected present, actual missing'));
    }
    return diffs;
  }

  if (isBlankEquivalentString(valA) && isBlankEquivalentString(valB)) {
    return diffs;
  }

  if (isBlankString(valA) || isBlankString(valB)) {
    const nonBlank = isBlankString(valA) ? valB : valA;
    if (
      nonBlank === null ||
      nonBlank === undefined ||
      (typeof nonBlank === 'string' &&
        (isBlankEquivalentString(nonBlank) || getNumericStringType(nonBlank)))
    ) {
      return diffs;
    }
  }

  const typeA = getValueType(valA);
  const typeB = getValueType(valB);

  if (isNumericType(typeA) && isNumericType(typeB)) {
    const isDecimalLikeA = isDecimalLikeType(typeA);
    const isDecimalLikeB = isDecimalLikeType(typeB);

    if (isDecimalLikeA !== isDecimalLikeB) {
      diffs.push(
        makeDiff(path, valA, valB, 'type mismatch', {
          expectedType: typeA,
          actualType: typeB
        })
      );
    }

    return diffs;
  }

  if (typeA !== typeB) {
    diffs.push(
      makeDiff(path, valA, valB, 'type mismatch', {
        expectedType: typeA,
        actualType: typeB
      })
    );
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
        if (!shouldSkipReplayEnrichmentDifference(childPath, sortedA[i], '<missing>', logTag)) {
          diffs.push(makeDiff(childPath, sortedA[i], '<missing>', 'element missing in actual'));
        }
      } else {
        if (!shouldSkipReplayEnrichmentDifference(childPath, '<missing>', sortedB[i], logTag)) {
          diffs.push(makeDiff(childPath, '<missing>', sortedB[i], 'extra element in actual'));
        }
      }
    }
    return diffs;
  }

  if (isPlainObject(valA) && isPlainObject(valB)) {
    const keysA = Object.keys(valA).sort();
    const keysB = Object.keys(valB).sort();
    
    for (const k of keysA) {
      const childPath = path ? `${path}.${k}` : k;
      if (!Object.prototype.hasOwnProperty.call(valB, k)) {
        if (
          !shouldSkipComparison(childPath, valA[k], undefined, ignore) &&
          !shouldSkipReplayEnrichmentDifference(childPath, valA[k], '<missing>', logTag)
        ) {
          diffs.push(makeDiff(childPath, valA[k], '<missing>', 'key missing in actual'));
        }
      }
    }
    
    for (const k of keysB) {
      const childPath = path ? `${path}.${k}` : k;
      if (!Object.prototype.hasOwnProperty.call(valA, k)) {
        if (
          !shouldSkipComparison(childPath, undefined, valB[k], ignore) &&
          !shouldSkipReplayEnrichmentDifference(childPath, '<missing>', valB[k], logTag)
        ) {
          diffs.push(makeDiff(childPath, '<missing>', valB[k], 'extra key in actual'));
        }
      }
    }
    
    for (const k of keysA) {
      if (Object.prototype.hasOwnProperty.call(valB, k)) {
        const childPath = path ? `${path}.${k}` : k;
        diffs.push(...compareValues(valA[k], valB[k], childPath, ignore, logTag));
      }
    }
    return diffs;
  }

  if (valA !== valB) {
    if (!shouldSkipReplayEnrichmentDifference(path, valA, valB, logTag)) {
      diffs.push(makeDiff(path, valA, valB, 'value mismatch'));
    }
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

  if (typeof expected === 'string') {
    try {
      expected = JSON.parse(expected);
    } catch {
      // Not valid JSON, keep as string
    }
  }

  if (typeof actual === 'string') {
    try {
      actual = JSON.parse(actual);
    } catch {
      // Not valid JSON, keep as string
    }
  }

  ({ expected, actual } = unwrapComparableEnvelope(expected, actual));

  const diffArray = compareObjects(expected, actual, logTag);

  const differences = {};
  const differenceList = [];
  for (const diff of diffArray) {
    const key = diff.path || 'root';
    const normalizedDiff = { ...diff, path: key };
    differences[key] = normalizedDiff;
    differenceList.push(normalizedDiff);
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
