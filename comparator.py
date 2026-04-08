"""
JSON Object Comparator Library

Compares two JSON objects by:
1. Recursively walking both objects
2. Sorting lists by comparable fields before positional comparison
3. Skipping fields that key_check marks as False
4. Skipping user-defined ignore paths per log_tag (loaded from ignore_keys.json)
"""

import json
import os
from typing import Any

from key_check import key_check

IGNORE_KEYS_FILE = "ignore_keys.json"


def _load_ignore_keys(log_tag: str) -> set[str]:
    """
    Load ignore_keys.json and return the set of paths to skip
    for the given log_tag. Returns an empty set if the file
    doesn't exist or the log_tag has no entries.
    """
    if not os.path.exists(IGNORE_KEYS_FILE):
        return set()
    with open(IGNORE_KEYS_FILE) as f:
        ignore_map = json.load(f)
    return set(ignore_map.get(log_tag, []))


# ---------------------------------------------------------------------------
# List sorting
# ---------------------------------------------------------------------------

def _sort_key(item: Any) -> str:
    """
    Build a deterministic sort key for a list element.

    For dicts: uses only the leaf fields that pass key_check (comparable
    fields), so that filtered-out values like IDs and timestamps don't
    affect ordering.
    For everything else: uses the JSON string representation.
    """
    if isinstance(item, dict):
        comparable = {}
        for k, v in item.items():
            if isinstance(v, (dict, list)):
                continue
            if key_check(k, v):
                comparable[k] = v
        return json.dumps(comparable, sort_keys=True, default=str)
    return json.dumps(item, sort_keys=True, default=str)


# ---------------------------------------------------------------------------
# Recursive comparator
# ---------------------------------------------------------------------------

def _compare_values(val_a: Any, val_b: Any, path: str, key: str,
                    ignore: set[str] | None = None) -> list[list]:
    """
    Recursively compare two values.

    Parameters
    ----------
    val_a, val_b : values from object-1 and object-2
    path         : dot-separated path for reporting (e.g. "trace_request.lineDetail")
    key          : the immediate key name that holds these values
    ignore       : set of dot-separated paths to skip entirely

    Returns
    -------
    [] if identical (after filtering), otherwise
    [[path, val_a, val_b], ...] for every mismatch.
    """
    diffs: list[list] = []

    # --- skip ignored paths (entire subtree) ---
    if ignore and path in ignore:
        return diffs

    # --- both None / null ---
    if val_a is None and val_b is None:
        return diffs

    # --- both dicts -> recurse per key ---
    if isinstance(val_a, dict) and isinstance(val_b, dict):
        all_keys = sorted(set(val_a.keys()) | set(val_b.keys()))
        for k in all_keys:
            child_path = f"{path}.{k}" if path else k
            sub_a = val_a.get(k)
            sub_b = val_b.get(k)
            diffs.extend(_compare_values(sub_a, sub_b, child_path, k, ignore))
        return diffs

    # --- both lists -> sort by comparable fields, then compare positionally ---
    if isinstance(val_a, list) and isinstance(val_b, list):
        sorted_a = sorted(val_a, key=_sort_key)
        sorted_b = sorted(val_b, key=_sort_key)
        for i in range(max(len(sorted_a), len(sorted_b))):
            child_path = f"{path}[{i}]"
            if i < len(sorted_a) and i < len(sorted_b):
                diffs.extend(_compare_values(sorted_a[i], sorted_b[i], child_path, key, ignore))
            elif i < len(sorted_a):
                diffs.append([child_path, sorted_a[i], "<missing>"])
            else:
                diffs.append([child_path, "<missing>", sorted_b[i]])
        return diffs

    # --- type mismatch (e.g. dict vs None, list vs str) ---
    type_a = type(val_a).__name__
    type_b = type(val_b).__name__
    if type_a != type_b:
        if not key_check(key, val_a) or not key_check(key, val_b):
            return diffs
        diffs.append([path, val_a, val_b])
        return diffs

    # --- leaf comparison (same type, both primitives) ---
    if not key_check(key, val_a) or not key_check(key, val_b):
        return diffs

    if val_a != val_b:
        diffs.append([path, val_a, val_b])

    return diffs


# ---------------------------------------------------------------------------
# Public API
# ---------------------------------------------------------------------------

def compare_objects(obj_a: dict, obj_b: dict, log_tag: str) -> list[list]:
    """
    Compare two JSON objects (dicts) and return a flat list of differences.

    Parameters
    ----------
    obj_a   : first JSON object (dict)
    obj_b   : second JSON object (dict)
    log_tag : identifier used to look up ignore paths from ignore_keys.json

    Returns
    -------
    A list of [path, value_in_obj1, value_in_obj2] for every mismatch.
    Returns [] if the objects are equivalent (after field filtering).
    """
    ignore = _load_ignore_keys(log_tag)
    return _compare_values(obj_a, obj_b, "", "", ignore or None)