/**
 * Key check utility - determines if a key/value pair should be compared
 * Filters out dynamic fields like IDs, timestamps, masked data, etc.
 *
 * Rules (applied in order):
 *   1. Keys ending with 'id' (case-insensitive) -> False,
 *      EXCEPT merchant_id / merchantId and keys ending with org_id / orgId.
 *   2. Keys ending with 'ipAddress' (case-insensitive) -> False.
 *   3. Keys ending with 'message' (case-insensitive) -> False.
 *   4. Value starts with 'XXX' (PI / masked data) -> False.
 *   5. Value matches an ISO 8601 timestamp -> False.
 *   6. trace_error_msg -> False.
 *   7. Everything else -> True.
 */

// ISO 8601 timestamp pattern (e.g. 2026-04-07T05:05:05.870799315Z)
const TIMESTAMP_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/;

/**
 * Given a key name and its value from trace logs, return True if the field
 * is safe to keep, or False if it should be ignored/masked.
 *
 * @param {string} key - The field name
 * @param {*} value - The field value
 * @returns {boolean} - True if should be compared, false if should be skipped
 */
export function keyCheck(key, value) {
  if (!key) return true;

  // Normalize key: lowercase and remove underscores
  const normalized = key.toLowerCase().replace(/_/g, '');

  // Rule 1: keys ending with "id" (case-insensitive, underscore-insensitive)
  if (/id$/.test(normalized)) {
    // Exception: merchantid
    if (/merchantid$/.test(normalized)) {
      return true;
    }
    // Exception: keys ending with orgid
    if (/orgid$/.test(normalized)) {
      return true;
    }
    // Exception: boolean-style keys (e.g. isPartiallyRepaid)
    if (/paid$/.test(normalized)) {
      return true;
    }
    return false;
  }

  // Rule 2: keys ending with "ipaddress" (normalized)
  if (/ipaddress/.test(normalized)) {
    return false;
  }

  // Rule 3: keys ending with "message" (normalized)
  if (/message$/.test(normalized)) {
    return false;
  }

  // Only check value-based rules for string values
  if (typeof value === 'string') {
    // Rule 4: value starts with "XX" (PI / masked data)
    if (value.startsWith('XX')) {
      return false;
    }

    // Rule 5: value is a timestamp
    if (TIMESTAMP_RE.test(value)) {
      return false;
    }
  }

  // Rule 6: trace_error_msg (normalized: traceerrormsg)
  if (normalized === 'traceerrormsg') {
    return false;
  }

  // Rule 7: everything else is safe
  return true;
}

export default keyCheck;
