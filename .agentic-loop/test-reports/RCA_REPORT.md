# Root Cause Analysis Report

## Metadata
- Timestamp (UTC): 2026-05-21 07:17:00 UTC
- Trigger: Gateway returns "VINATGE_DETAILS_NOT_FOUND" during LSP-FetchOfferRequest_REQUEST processing
- Classification: SPECIFIC (Has exact stack trace and line number)

## Failing API
- Endpoint: /gateway/v1.0/fetchOfferRequest
- HTTP Code: 500 (Internal Server Error)
- Request ID: 64d4c2c4-f498-470d-ade0-90be241307fb (x-request-id)
- Loan Application ID: LSPc02da02d7f014d4f9212738ad5b79fbf

## Root Cause
- Category: Missing required field in request payload
- Exact Issue: `vintageData` is null/empty in `checkoutData.metadata` when gateway processes the fetchOfferRequest
- Source Location: `src/ConsumerDurables/TvsCredit/Transforms/CheckEligibility.hs:82`
- Source Context:
```haskell
  vintageDataRaw <- maybe (Errors.logAndThrowErr500 "VINATGE_DETAILS_NOT_FOUND" "VINATGE_DETAILS_NOT_FOUND") pure $ (checkoutData ^. #metadata) ^. #vintageData
  vintageData <- case (fromJSON (Object vintageDataRaw) :: Result Types.VintageData) of
    Success vd -> pure vd
    Error err -> Errors.logAndThrowErr500 "VINTAGE_DATA_PARSE_ERROR" ("Failed to parse vintage data: " <> Text.pack err)
```
- Call Stack:
```
logAndThrowErr500, called at src/ConsumerDurables/TvsCredit/Transforms/CheckEligibility.hs:81:28 in tvs-credit-0.0.1.0-4EzKVISPEhaDkoZmerF7Em:ConsumerDurables.TvsCredit.Transforms.CheckEligibility
```

## Analysis

### Production vs Replay Comparison

**Production Logs (from `logs-7def7805-eb7c-4e10-8f8a-428615f67d32.json`):**
- `LSP-FetchOfferRequest_REQUEST.trace_request.loanApplication.checkoutData.metadata.vintageData` = **Present** (dict with ~30 fields including `affluence_score`, `device_id`, `add_lat`, etc.)

**Replay Environment (from orchestrator logs):**
- Incoming request from LSP to orchestrator shows:
  - `loanApplication.borrower.vintageData = {}` (EMPTY OBJECT)
  - `loanApplication.checkoutData.metadata.vintageData = null` (NULL)

### Why the Orchestrator Doesn't Catch This
The orchestrator's payload comparator marks the request as "validation passed" (`comparisonMatch: true`), which indicates the comparator is too lenient with null/empty values compared to populated objects. This allows the request to proceed to the gateway despite missing critical data.

### Why LSP Doesn't Include vintageData in Replay
The `vintageData` originates from upstream merchant data enrichment (likely from Flipkart's customer profile/vintage data service) that was available during the original production flow. In the replay environment:
1. The orchestrator replays individual API calls from logs
2. LSP rebuilds its internal state from scratch for each replay
3. The upstream data that originally populated `vintageData` (either from merchant callbacks, internal caching, or session state) is not seeded into the replay environment
4. LSP constructs the `FetchOfferRequest` without `vintageData` because it has no source for this data in replay

## Correlation
- Search Path Taken: Gateway error logs -> Source code inspection -> Production log comparison -> Orchestrator log analysis
- Step Where Found: Step 5B (CallStack parsing) + Step 5C (payload comparison)
- Logs Searched: 
  - `/home/kumar-aman/Desktop/repos/euler-lsp/logs/euler-lsp-api-gateway.log`
  - `/home/kumar-aman/Desktop/repos/art-orchestrator/orchestrator-output.log`
  - `/home/kumar-aman/Desktop/repos/art-orchestrator/data/logs-7def7805-eb7c-4e10-8f8a-428615f67d32.json`

## Recommended Actions

1. **Seed vintageData in replay environment**: 
   - Modify the orchestrator or onboarding to inject merchant profile/vintage data into LSP's database/cache before running the replay
   - OR: Add a data seeding step that populates the required vintageData fields based on the merchant and customer

2. **Fix the gateway error handling** (if this is a legitimate scenario):
   - Update `CheckEligibility.hs` to handle missing `vintageData` gracefully instead of throwing a 500 error
   - Consider making vintageData optional or providing default values

3. **Improve orchestrator payload comparison**:
   - Enhance the comparator to flag null/empty values when the expected log has populated objects
   - This would catch data mismatches before they reach the gateway

4. **Add upstream data mocking**:
   - If vintageData comes from a Flipkart/TVS API, add mock responses for that API in the replay environment
   - The orchestrator should trigger these mocks before the eligibility call

## Raw Log Excerits

### Gateway Error (from euler-lsp-api-gateway.log):
```
{"timestamp":"2026-05-21 06:49:40.686","level":"Error","tag":"VINATGE_DETAILS_NOT_FOUND",
 "message":"VINATGE_DETAILS_NOT_FOUND CallStack (from HasCallStack):\n  logAndThrowErr500, 
 called at src/ConsumerDurables/TvsCredit/Transforms/CheckEligibility.hs:81:28 
 in tvs-credit-0.0.1.0-4EzKVISPEhaDkoZmerF7Em:ConsumerDurables.TvsCredit.Transforms.CheckEligibility"}
```

### Production Log with vintageData (truncated):
```json
{
  "log_tag": "LSP-FetchOfferRequest_REQUEST",
  "trace_request": {
    "loanApplication": {
      "checkoutData": {
        "metadata": {
          "vintageData": {
            "add_type_others": "0",
            "number_of_device_ids": "X",
            "pcd_gmv_value_24m": "1339.0",
            "add_age": "161",
            "device_id": "TI175865061543400187510258895288502943522532108819402309239377578763",
            "affluence_score": "L",
            ...
          }
        }
      }
    }
  }
}
```
