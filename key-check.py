import re

# ISO 8601 timestamp pattern (e.g. 2026-04-07T05:05:05.870799315Z)
TIMESTAMP_RE = re.compile(
    r"^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}"
)


def key_check(key: str, value) -> bool:
    """
    Given a key name and its value from trace logs, return True if the field
    is safe to keep, or False if it should be ignored/masked.

    Rules (applied in order):
      1. Keys ending with 'id' (case-insensitive) -> False,
         EXCEPT merchant_id / merchantId and keys ending with org_id / orgId.
      2. Keys ending with 'ipAddress' (case-insensitive) -> False.
      3. Value starts with 'XXX' (PI / masked data) -> False.
      4. Value matches an ISO 8601 timestamp -> False.
      5. trace_error_msg -> False.
      6. Everything else -> True.
    """
    normalized = key.lower().replace("_", "")

    # Rule 1: keys ending with "id" (case-insensitive, underscore-insensitive)
    if re.search(r"id$", normalized):
        # Exception: merchantid
        if re.search(r"merchantid$", normalized):
            return True
        # Exception: keys ending with orgid
        if re.search(r"orgid$", normalized):
            return True
        # Exception: boolean-style keys (e.g. isPartiallyRepaid)
        if re.search(r"paid$", normalized):
            return True
        return False

    # Rule 2: keys ending with "ipaddress" (normalized)
    if re.search(r"ipaddress", normalized):
        return False

    # Only check value-based rules for string values
    if isinstance(value, str):
        # Rule 3: value starts with "XXX" (PI / masked data)
        if value.startswith("XXX"):
            return False

        # Rule 4: value is a timestamp
        if TIMESTAMP_RE.match(value):
            return False

    # Rule 5: trace_error_msg (normalized: traceerrormsg)
    if normalized == "traceerrormsg":
        return False

    # Rule 6: everything else is safe
    return True


if __name__ == "__main__":
    import sys

    if len(sys.argv) < 3:
        print('Usage: python key_check.py <key> <value>')
        sys.exit(1)

    key = sys.argv[1]
    value = sys.argv[2]
    result = key_check(key, value)
    print(f"{key} ({value}) -> {result}")