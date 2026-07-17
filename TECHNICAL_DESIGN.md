# ART Technical Design

This document explains how ART works today in the codebase, with the goal of helping developers understand, debug, and extend the orchestrator safely.

It is intentionally implementation-oriented. Where older design notes describe ART as a simple sequential log runner with worker threads, this document reflects the current architecture in `/home/kumar-aman/Desktop/repos2/ART-orchestrator`.

## 1. What ART Does

ART replays real production journeys locally and checks whether the current LSP and Gateway behavior still matches production expectations closely enough for regression validation.

At a high level, ART:

- fetches and sanitizes production logs for one or more orders
- reconstructs the expected replay sequence
- starts local infrastructure that intercepts inter-service traffic
- replays APP-side and lender-side triggers
- forwards live calls to LSP and Gateway where required
- mocks lender and other replay-only branches from logs
- compares actual replay behavior with production logs
- generates structured reports

The main replay goal is not “exact packet-for-packet simulation.” The goal is stable behavioral reproduction of real journeys in a local stack, while tolerating known async drift, reordered callbacks, and replay-only ID differences.

## 2. Runtime Model

### 2.1 Services in Replay

In the common setup:

- `LSP` is live
- `Gateway` is live
- `APP` is replayed by ART
- `LENDER` is replayed or mocked by ART
- some auxiliary branches like webhook/test/helper flows are replay-controlled by ART

Conceptually the production chain is:

- `APP <-> LSP <-> GATEWAY <-> LENDER`

During replay, ART sits in the middle and becomes the routing/control plane:

- `APP (ART-triggered) <-> LSP <-> ART multiplexer <-> GATEWAY <-> ART mocked/replayed lender side`

### 2.2 Modes

ART supports two execution styles:

- `Async orchestrator` mode: current default and primary path
- `Sequential/sync` mode: legacy path kept for compatibility and some tests

The async path is the one developers should treat as the primary design.

## 3. Major Components

### 3.1 Entry and Execution Control

Main startup lives in [src/index.js](/home/kumar-aman/Desktop/repos2/ART-orchestrator/src/index.js).

Responsibilities:

- parse env configuration
- choose order source
- decide whether to use fetched logs or existing final logs
- start the multiplexer server
- run ART replay over one or many orders
- generate summary output and reports

Important environment switches include:

- `USE_ASYNC_ORCHESTRATOR`
- `ORDER_LIST`
- `USE_ART_FINAL_STORE_LOGS`
- `USE_EXISTING_FINAL_FILTERED_LOGS`
- `MULTI_ART_ENABLED`
- `ART_WORKER_INDEX`
- `ART_WORKER_COUNT`

### 3.2 Log Fetching and Sanitization

Primary fetching and filtering logic lives in:

- [src/services/log-fetcher.js](/home/kumar-aman/Desktop/repos2/ART-orchestrator/src/services/log-fetcher.js)
- [src/log-fetcher/](/home/kumar-aman/Desktop/repos2/ART-orchestrator/src/log-fetcher)

Responsibilities:

- fetch order logs from source APIs / stores
- fetch LAID-linked logs when allowed
- merge multiple log sources
- sort logs for replay
- normalize missing metadata
- drop noisy or unsafe logs
- apply replay-specific sequencing fixes
- write filtered and final-filtered log artifacts

Important behavior that exists today:

- filtering is not just chronological sort; it includes replay-aware correction
- some logs with missing `trace_route` are preserved and normalized
- some dotted/internal log tags are intentionally dropped
- request/response pairs are balanced for replay
- contaminated LAID log sets can be discarded
- multiple endpoint-to-logTag ambiguities are resolved using lookahead context

### 3.3 Session Routing and Multiplexing

Incoming live traffic is received by the ART multiplexer in:

- [src/dashboard/multiplexer.js](/home/kumar-aman/Desktop/repos2/ART-orchestrator/src/dashboard/multiplexer.js)
- [src/dashboard/session-registry.js](/home/kumar-aman/Desktop/repos2/ART-orchestrator/src/dashboard/session-registry.js)

This is a critical part of ART.

Responsibilities:

- receive incoming HTTP requests from LSP and Gateway
- identify which active replay session/order the request belongs to
- derive `logTag` and `sourceDestination`
- prefer `x-logtag` and `x-source_destination` headers when present
- fall back to endpoint-based config mapping when headers are absent
- forward the request into the correct orchestrator instance

Current behavior:

- session routing is not global singleton logic anymore
- ART can host multiple active replay sessions
- request classification can use both headers and config lookahead
- detailed incoming mapping debug logs are emitted for investigation

### 3.4 Replay Engine

There are two related orchestrator layers:

- [src/orchestrator.js](/home/kumar-aman/Desktop/repos2/ART-orchestrator/src/orchestrator.js)
- [src/async-buffer/async-orchestrator.js](/home/kumar-aman/Desktop/repos2/ART-orchestrator/src/async-buffer/async-orchestrator.js)

`ReplayOrchestrator` owns replay state, comparison, rewind, and high-level flow.

`AsyncOrchestrator` adds:

- non-blocking live forwarding
- buffered incoming request handling
- async request tracking
- immediate-process and self-trigger behavior
- optional skip / fallback logic

### 3.5 Buffering Layer

Core async buffering lives in:

- [src/async-buffer/buffer-manager.js](/home/kumar-aman/Desktop/repos2/ART-orchestrator/src/async-buffer/buffer-manager.js)
- [src/async-buffer/non-blocking-http.js](/home/kumar-aman/Desktop/repos2/ART-orchestrator/src/async-buffer/non-blocking-http.js)

This is more advanced than a simple “sync buffer / async buffer” split.

Today ART maintains buffered state for:

- incoming live requests observed from LSP/Gateway
- outstanding forwarded live requests
- completed responses
- preserved fallback entries used after rewind
- early-arrived callbacks and out-of-order events

Key design idea:

- ART does not assume requests arrive exactly when the replay cursor expects them
- requests may arrive early, late, duplicate, or after a rewind
- ART keeps enough context to match by log meaning, not only by timing

### 3.6 Request Forwarding

Forwarding logic is mainly in:

- [src/processing/request-forwarder.js](/home/kumar-aman/Desktop/repos2/ART-orchestrator/src/processing/request-forwarder.js)
- [src/services/http-client.js](/home/kumar-aman/Desktop/repos2/ART-orchestrator/src/services/http-client.js)

Responsibilities:

- build outgoing payloads
- apply replay ID remapping
- add APP_CORE auth/session/origin/version headers
- wrap APP_CORE and SDK-wrapper requests into the correct text envelope format
- choose request timeout overrides
- tolerate some configured fallback failures

### 3.7 State and ID Mapping

Replay identity state is handled in:

- [src/services/state-manager.js](/home/kumar-aman/Desktop/repos2/ART-orchestrator/src/services/state-manager.js)

This is one of the most important ART subsystems.

Responsibilities:

- seed production identifiers from logs
- capture live replay identifiers from actual service traffic
- maintain current “latest replay value” for many ID classes
- rewrite outgoing payloads recursively so stale production IDs are replaced by live replay IDs
- preserve replay context through rewind

Identifier classes currently handled include:

- `loanApplicationId`
- `agreementId`
- `offerId`
- `sessionToken`
- `txnRefId`
- `customerId`
- `requestId`
- `lineDetailId`
- `merchantUserId`
- `referenceId`
- `actionRequiredId`

Request-id mapping is logTag-aware. That means the same production request-id value is not blindly mapped globally; ownership is tied to the logTag where it first appeared.

### 3.8 Special Cases and Fallback Policy

Replay-specific rules live in:

- [src/replay-special-cases.js](/home/kumar-aman/Desktop/repos2/ART-orchestrator/src/replay-special-cases.js)

This file is the main declarative control surface for:

- polling APIs
- optional repeated entries
- skippable async APIs
- self-trigger fallback APIs
- immediate direct replay tags
- batch/tolerated cases like Themis branches

This is where many merchant/lender-specific replay relaxations are encoded.

## 4. Replay Data Flow

## 4.1 Per-Order Preparation

For each order, ART does roughly this:

1. fetch raw order logs
2. optionally fetch related LAID logs
3. filter and sanitize
4. normalize routing metadata
5. build final replay sequence
6. seed state from those logs
7. onboard seed data/configs into the local environment
8. start replay loop

## 4.2 Replay Cursor

ART keeps a current replay index over the final filtered log sequence.

Each entry represents an expected production event such as:

- APP -> LSP request
- CORE -> GATEWAY request
- GATEWAY -> LENDER request
- callback/async response
- webhook trigger

The cursor advances when ART has enough confidence that the expected step is satisfied.

That does not always mean:

- “the exact network call happened at exactly that time”

It can also mean:

- the entry was already satisfied earlier and marked processed
- the entry was skipped under an allowed replay policy
- the entry was satisfied via preserved fallback state after rewind
- the entry was handled by an immediate/special path

## 4.3 APP-Core and APP-Wrapper Requests

When replay reaches an APP-initiated entry, ART may actively trigger the live service call itself.

Examples:

- APP -> LSP APIs
- wrapper/SDK APIs
- some status APIs

Forwarding behavior depends on sourceDestination and endpoint mapping from [src/config.js](/home/kumar-aman/Desktop/repos2/ART-orchestrator/src/config.js).

## 4.4 Live Incoming Traffic

When LSP or Gateway calls ART, the multiplexer:

1. classifies the request
2. finds the owning replay session
3. converts it into an internal incoming request event
4. passes it to the orchestrator

The orchestrator then decides whether to:

- process it immediately
- buffer it for later sequence matching
- compare and forward it to a live downstream service
- respond immediately from replay logs
- record it as unexpected actual traffic

## 4.5 GATEWAY_LENDER Behavior

Gateway-to-lender traffic is usually replay-controlled.

Typical behavior:

- Gateway sends a lender request to ART
- ART either responds immediately from replay logs or buffers/matches it depending on the flow
- no real lender call is needed for the common mocked path

Some lender-side flows are special:

- webhook-triggered flows
- PT-triggered flows
- status-check APIs sharing one endpoint but multiple log tags
- immediate-response APIs

## 5. Matching Model

ART does not match only by endpoint.

Matching uses combinations of:

- `logTag`
- `sourceDestination`
- request direction
- replay index context
- request payload similarity
- identifiers like `loanApplicationId`, `requestId`, `lenderOrgId`
- merchant/lender-specific context

Relevant supporting modules:

- [src/services/response-matcher.js](/home/kumar-aman/Desktop/repos2/ART-orchestrator/src/services/response-matcher.js)
- [src/services/comparator.js](/home/kumar-aman/Desktop/repos2/ART-orchestrator/src/services/comparator.js)
- [src/services/log-sequence-validator.js](/home/kumar-aman/Desktop/repos2/ART-orchestrator/src/services/log-sequence-validator.js)

Important practical point:

when multiple buffered requests share the same logTag, ART relies on more than tag equality. Sequence context and request fields matter. This is why replay bugs often show up when repeated polling/status APIs share endpoints but differ subtly by request shape or requestId.

## 6. Immediate Processing, Skip, and Self-Trigger

Current ART behavior is intentionally more flexible than strict sequential replay.

### 6.1 Immediate Processing

Some log tags are configured so that when the live request arrives, ART serves it immediately rather than waiting for the main replay cursor to reach that entry.

This is used when waiting would cause real upstream timeouts.

Examples include several lender/status APIs and merchant-specific branches.

### 6.2 Skippable Async Entries

Some async request/response entries are allowed to be skipped if:

- ART waited long enough
- the journey already advanced in a way that proves the branch is no longer necessary
- the entry is explicitly listed in special-case policy

This prevents replay from hanging forever on production callbacks that are not re-emitted identically in local runs.

### 6.3 Self-Trigger Fallback

For selected APIs, if the expected incoming request never appears within a short wait window, ART can trigger the downstream call itself.

This is used when local replay depends on an internal call that production emitted, but the local branch did not emit again during replay.

### 6.4 Optional Repeated Entries

Repeated polling/status calls often appear many times in production. ART can be configured to:

- require the first occurrence
- allow later occurrences to be skipped
- skip only if a prior occurrence succeeded
- skip only if later replay branch advancement has already been observed

These policies live in [src/replay-special-cases.js](/home/kumar-aman/Desktop/repos2/ART-orchestrator/src/replay-special-cases.js).

## 7. Rewind Model

Rewind exists to recover from local replay divergence without restarting the entire order from scratch.

### 7.1 Why Rewind Exists

Common causes:

- missing expected buffered request
- polling branch emitted in production but not again locally
- replay cursor advanced into a dead wait

### 7.2 Current Rewind Strategy

ART can:

- remember the last processed polling API
- remember its replay index
- stop the current stalled attempt near timeout
- rewind the replay index in place
- preserve selected replay state
- retry from a safer point

This is not full orchestrator reinitialization.

Important behavior:

- ART rewinds the replay index and transient replay state
- it does not fully recreate the whole process by default
- preserved fallback buffered entries may remain available for replay recovery

The in-place rewind implementation is visible in [src/orchestrator.js](/home/kumar-aman/Desktop/repos2/ART-orchestrator/src/orchestrator.js).

## 8. APP_CORE Request Construction

APP_CORE forwarding has special rules and is a frequent source of replay breakage.

Current logic includes:

- auth/session header reconstruction
- `x-merchant-id`
- `x-order-id`
- `x-loan-request-info-id`
- `x-logging-flag`
- `x-session-token`
- `x-user-id`
- `x-device-token-id`
- `x-forwarded-for`
- `x-origin`
- `x-version`

These are built primarily in:

- [src/services/app-core-auth-headers.js](/home/kumar-aman/Desktop/repos2/ART-orchestrator/src/services/app-core-auth-headers.js)
- [src/services/http-client.js](/home/kumar-aman/Desktop/repos2/ART-orchestrator/src/services/http-client.js)

APP_CORE requests are usually sent as an unencrypted text envelope, not as raw JSON body objects.

That distinction matters for many LSP endpoints.

## 9. Endpoint and LogTag Mapping

Replay routing depends heavily on [src/config.js](/home/kumar-aman/Desktop/repos2/ART-orchestrator/src/config.js).

This file defines:

- `logTag + sourceDestination -> endpoint/service`
- `endpoint -> logTag/sourceDestination`
- service mapping
- endpoint ambiguity resolution
- timeout overrides
- merchant/lender route variants

Many replay failures that look like orchestration issues are actually missing or incorrect config mappings.

Examples of config-sensitive cases:

- one endpoint corresponding to multiple log tags
- different merchants using different wrapper paths
- APP_CORE trigger/status APIs mounted under different version prefixes
- Gateway mock endpoints that need header-based classification

## 10. Reports and Debugging Outputs

ART generates multiple useful outputs.

Primary outputs:

- `report.json`
- html/pdf report views
- filtered and final-filtered log files
- `art.log`
- `art-debugger.log`
- `art-incoming.log`
- `art-outgoing.log`
- `art-request-flow.log`

What each is best for:

- `final-filtered-logs`: understand the exact replay sequence
- `art-incoming.log`: see what live services sent into ART
- `art-outgoing.log`: see what ART forwarded or mocked out
- `art-debugger.log`: deep replay state and routing decisions
- `art.log`: higher-level order progress and failures

## 11. Common Failure Classes

Developers usually hit one of these categories:

### 11.1 Unmapped Endpoint or Wrong SourceDestination

Symptoms:

- `Unknown service: CORE`
- `/api/unknown`
- “Ignoring unmapped API endpoint”

Usual fix:

- add or correct mapping in `src/config.js`
- confirm actual endpoint version and mount path in LSP/Gateway code

### 11.2 Missing APP_CORE Headers

Symptoms:

- `ORIGIN_NOT_FOUND`
- `SESSION_NOT_FOUND`
- auth/header validation failures

Usual fix:

- patch `buildAppCoreAuthHeaders`
- patch APP_CORE envelope building

### 11.3 Wrong ID Remap

Symptoms:

- loan application not found
- merchant user not found
- stale requestId/sessionToken/customerId propagated into later calls

Usual fix:

- inspect state-manager capture source
- verify production alias seeding
- verify current replay value overwrite rules

### 11.4 Async Wait/Timeout Drift

Symptoms:

- request clearly arrived in logs but replay still waited
- response served in live service but ART did not advance
- local upstream timeout despite replay eventually seeing the request

Usual fix:

- inspect immediate-process and skip/self-trigger policies
- inspect buffered matching context
- inspect whether the entry was already processed or claimed

### 11.5 Contaminated Logs

Symptoms:

- unrelated order IDs mixed into a single LAID log set
- impossible sequence
- repeated stale branches from previous journeys

Usual fix:

- tighten filtering/sanitization
- discard contaminated LAID set
- skip replay for that order if logs are fundamentally unsafe

## 12. Safe Extension Pattern

When adding support for a new API or fixing a replay branch, use this order:

1. confirm the real endpoint in LSP/Gateway source code
2. confirm the production `logTag` and `trace_route`
3. add config mapping in both directions if needed
4. decide whether the API is:
   - strict sequential
   - immediate-process
   - self-trigger fallback
   - skippable optional repeat
5. verify whether replay ID remapping must apply
6. add targeted tests
7. validate with real replay logs

Do not patch only the symptom in one place if the issue is really shared request construction, mapping, or state capture.

## 13. Mental Model for Developers

The most useful way to think about ART is:

- ART is a replay state machine driven by production logs
- the multiplexer is the entry point for actual service traffic
- config maps convert between endpoints and replay semantics
- the state manager rewrites stale production identities into current replay identities
- buffer management allows live traffic and replay cursor to drift temporarily
- special-case policy exists to keep real local services from timing out on replay-only gaps

If something fails, debug in this order:

1. was the final filtered sequence correct?
2. was the incoming request classified to the correct `logTag` and `sourceDestination`?
3. did ART have the correct endpoint mapping?
4. did outgoing payload/header remapping produce valid live IDs?
5. did the request get buffered, processed, skipped, or rewound under an expected policy?

## 14. Suggested Reading Order for New Developers

Start here:

1. [README.md](/home/kumar-aman/Desktop/repos2/ART-orchestrator/README.md)
2. [TECHNICAL_DESIGN.md](/home/kumar-aman/Desktop/repos2/ART-orchestrator/TECHNICAL_DESIGN.md)
3. [src/index.js](/home/kumar-aman/Desktop/repos2/ART-orchestrator/src/index.js)
4. [src/dashboard/multiplexer.js](/home/kumar-aman/Desktop/repos2/ART-orchestrator/src/dashboard/multiplexer.js)
5. [src/async-buffer/async-orchestrator.js](/home/kumar-aman/Desktop/repos2/ART-orchestrator/src/async-buffer/async-orchestrator.js)
6. [src/orchestrator.js](/home/kumar-aman/Desktop/repos2/ART-orchestrator/src/orchestrator.js)
7. [src/services/state-manager.js](/home/kumar-aman/Desktop/repos2/ART-orchestrator/src/services/state-manager.js)
8. [src/services/log-fetcher.js](/home/kumar-aman/Desktop/repos2/ART-orchestrator/src/services/log-fetcher.js)
9. [src/replay-special-cases.js](/home/kumar-aman/Desktop/repos2/ART-orchestrator/src/replay-special-cases.js)
10. [src/config.js](/home/kumar-aman/Desktop/repos2/ART-orchestrator/src/config.js)

## 15. Short Summary

ART is no longer just a simple sequential replay script.

It is a replay platform with:

- multi-session routing
- replay-aware log sanitization
- non-blocking buffering
- live-to-prod ID reconciliation
- configurable fallback policies
- in-place rewind
- rich diagnostics and reporting

That complexity is necessary because local replay of real production journeys is noisy, asynchronous, and full of IDs that cannot be reused directly.
