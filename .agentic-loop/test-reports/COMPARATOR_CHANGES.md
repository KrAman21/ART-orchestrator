# Enhanced Comparator Implementation Guide

## Goal
Make the comparator strictly validate request/response payloads by:
1. Detecting missing fields (null/object mismatches)
2. Comparing actual values (not skipping unmasked fields)
3. Logging detailed failure info
4. Stopping ART replay on mismatch
5. Using ignore_keys.json for excluded fields

---

## Issue: Why Missing vintageData Was NOT Caught

### The Problem
- `vintageData` is in `ignore_keys.json` globally ("*")
- `loadIgnoreKeys()` → `normalizeKey("vintageData")` → `"vintagedata"`
- `shouldIgnore("loanApplication.checkoutData.metadata.vintageData", ignore)`:
  1. Normalizes full path: `"loanapplicationcheckoutdatametadatavintagedata"`
  2. Checks exact: not in set ✗
  3. Checks segments: `vintageData` → normalized `"vintagedata"` → **MATCH!**
  4. **Result: Entire subtree skipped**

### Impact
Any field under `vintageData` or the key itself is completely ignored during comparison.

---

## Changes Required

### 1. Remove `vintageData` from ignore_keys.json (URGENT)

```json
{
  "*": [
    "firstname",
    "lastname",
    // ... other fields ...
    // REMOVE THIS LINE:
    "vintagedata"
  ]
}
```

**Why:** You explicitly want to detect when `vintageData` is missing in replay.

### 2. Fix `comparator.js` line 279: Enable Strict Matching

**Change from:**
```javascript
return {
  match: true, // diffArray.length === 0,
  differences
};
```

**Change to:**
```javascript
return {
  match: diffArray.length === 0,
  differences
};
```

**Impact:** All 11 `if (!comparison.match)` checks across the codebase will now ACTUALLY stop replay when mismatches are detected.

### 3. Remove/Override `keyCheck` Hardcoded Rules (OPTIONAL but recommended)

**Current behavior in `keyCheck.js`:**
- Automatically skips IDs, timestamps, IPs, messages
- These are hardcoded, not from `ignore_keys.json`

**Issue:** If you want to control skips ONLY via `ignore_keys.json`, these hardcoded rules cause hidden behavior.

**Recommendation:** Either:
- **Option A:** Remove hardcoded `keyCheck` rules and rely solely on `ignore_keys.json`
- **Option B:** Keep `keyCheck` for truly universal skips (IDs/timestamps) but document clearly

**My recommendation: Option A** — Centralize all skip logic in `ignore_keys.json` for transparency.

### 4. Enhancement: Log Comparison Details Verbosely

Update the comparison result logging to include a human-readable diff:

```javascript
// In comparator.js compareLog():
const diffMessages = diffArray.map(([path, exp, act]) => 
  `${path}: expected=${JSON.stringify(exp)}, actual=${JSON.stringify(act)}`
);

return {
  match: diffArray.length === 0,
  differences,
  diffSummary: diffMessages.join('; ')
};
```

This gives log lines like:
```
Payload comparison failed: metadata.vintageData: expected=[object], actual=null; 
metadata.orderId: expected="ABC", actual="XYZ"
```

### 5. Ensure All Call Sites Stop on Mismatch

These locations currently check `!comparison.match` and call `fail()`:

| File | Line | Context |
|------|------|---------|
| `orchestrator.js` | 449 | LSP→GW request validation |
| `request-forwarder.js` | 105 | GW→LSP response validation |
| `request-forwarder.js` | 436 | Downstream response validation |
| `request-forwarder.js` | 578 | External response validation |
| `log-processor.js` | 309 | External request response |
| `out-of-order-handler.js` | 127 | Async parallel call |
| `async-orchestrator.js` | 155, 208, 465, 539, 594 | Buffered response comparisons |

**All of these will now work correctly** once `match: diffArray.length === 0` is enabled.

### 6. Test: Verify vintageData Detection Works

After making the above changes, re-run the replay. You should see:

```
ERROR: ORCH_PAYLOAD_MISMATCH
  logTag: LSP-FetchOfferRequest_REQUEST
  differences: {
    "loanApplication.checkoutData.metadata.vintageData": {
      expected: "[object]",
      actual: null
    }
  }
  diffSummary: "loanApplication.checkoutData.metadata.vintageData: expected=[object], actual=null"
```

Then ART should call `this.fail()` and stop the replay.

---

## ignore_keys.json Maintenance Guide

### What Should Go Here
Fields that are **intentionally** different between production and replay:
- PII data (names, phone, PAN, email, DOB, addresses)
- Dynamic values (timestamps, request IDs, trace IDs)
- Environment-specific data (IP addresses)
- Data you explicitly don't want to compare

### What Should NOT Go Here
Fields whose absence indicates a **real bug**:
- Business logic data (vintageData, eligibility scores, offer details)
- Required fields that should be present in both environments
- Data that affects downstream processing

### Current Issues in ignore_keys.json
```json
{
  "*": [
    // ✅ PII - correct to ignore
    "firstname", "lastname", "mobilenumber", "pan", "email",
    
    // ⚠️ POTENTIALLY PROBLEMATIC:
    "vintagedata",          // ← REMOVE: You need to detect missing vintageData
    "riskdetails",          // ← REVIEW: Is this business-critical?
    "lenderextensibledata", // ← REVIEW: Is this business-critical?
    "consents",             // ← REVIEW: Are consents required fields?
    
    // ✅ Dynamic/environment - correct to ignore
    "trace", "ipaddress", "txnrefno"
  ]
}
```

---

## Summary of Files to Modify

| File | Change |
|------|--------|
| `ignore_keys.json` | Remove `"vintagedata"` (and review others) |
| `src/services/comparator.js` | Line 279: `match: diffArray.length === 0` |
| `src/services/comparator.js` | Add `diffSummary` to return value |
| `src/services/key-check.js` | (Optional) Remove hardcoded rules |

## No Other Changes Needed

The remaining code already handles failures correctly:
- `orchestrator.js:449-456` — logs `ORCH_PAYLOAD_MISMATCH` and calls `this.fail()`
- `request-forwarder.js:105-106` — calls `callbacks.fail('Response comparison failed')`
- All other sites similarly propagate errors

Just fix `match: true` → `match: diffArray.length === 0` and the whole system will start enforcing strict comparisons.
