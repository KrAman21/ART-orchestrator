# Async Request-Response Buffer System Design

## Problem Statement

The current orchestrator processes logs **sequentially** and **synchronously**. When LSP makes a callback (e.g., `LSP-FetchOfferRequest_REQUEST`), this request arrives out-of-sequence while the main thread is blocked waiting for a different response.

### Current Flow (Problematic)
```
1. Orch → LSP: FlipKart-HardEligibility_REQUEST
   ↓
2. Orch BLOCKS waiting for HardEligibility response
   ↓
3. LSP → Orch: LSP-FetchOfferRequest_REQUEST (callback)
   ↓
4. Orch receives FetchOfferRequest but can't process it
   because it's expecting HardEligibility_RESPONSE
   ↓
5. DEADLOCK: Orch is stuck, LSP waits for FetchOffer response
```

## Proposed Solution

Implement a **non-blocking async buffer system** with the following components:

### Architecture Overview

```
┌─────────────────────────────────────────────────────────────────────┐
│                      MAIN PROCESSING LOOP                            │
│  Continuously polls for work from multiple sources                   │
└────────────────────┬────────────────────────────────────────────────┘
                     │
         ┌───────────┴───────────┬───────────────────┐
         ▼                       ▼                   ▼
┌─────────────────┐  ┌─────────────────────┐  ┌─────────────────┐
│ LOG SEQUENCE    │  │ INCOMING REQUEST    │  │ RESPONSE BUFFER │
│ QUEUE           │  │ BUFFER              │  │                 │
│ (ordered logs)  │  │ (out-of-order reqs) │  │ (async results) │
└────────┬────────┘  └──────────┬──────────┘  └────────┬────────┘
         │                      │                      │
         └──────────────────────┼──────────────────────┘
                                ▼
                    ┌───────────────────────┐
                    │   PROCESSING ENGINE   │
                    │  - Match & validate   │
                    │  - Route requests     │
                    │  - Handle callbacks   │
                    └───────────────────────┘
```

### Core Components

#### 1. **Buffer Manager**
Central coordinator managing three queues:

```typescript
class BufferManager {
  // Queue 1: Incoming requests from HTTP server (out-of-order)
  incomingRequestBuffer: Map<BufferKey, BufferedRequest>
  
  // Queue 2: Completed async responses waiting for pickup
  responseBuffer: Map<RequestId, BufferedResponse>
  
  // Queue 3: Pending promises for in-flight requests
  pendingPromises: Map<RequestId, PendingPromise>
  
  // Main thread checks these in priority order
  async getNextWorkItem(): Promise<WorkItem>
}
```

#### 2. **Non-Blocking Request Sender**
Fire-and-forget with promise tracking:

```typescript
async function sendRequestNonBlocking(entry: LogEntry): Promise<void> {
  // 1. Create a deferred promise
  const deferred = createDeferredPromise()
  
  // 2. Store in pending promises map
  bufferManager.pendingPromises.set(entry.requestId, {
    promise: deferred.promise,
    resolve: deferred.resolve,
    reject: deferred.reject,
    entry: entry
  })
  
  // 3. Fire HTTP request WITHOUT awaiting
  httpClient.send(entry).then(response => {
    // Response comes back later - store in buffer
    bufferManager.responseBuffer.set(entry.requestId, {
      response,
      entry,
      timestamp: Date.now()
    })
    
    // Notify main thread
    bufferManager.signalWorkAvailable()
  }).catch(error => {
    bufferManager.responseBuffer.set(entry.requestId, {
      error,
      entry,
      timestamp: Date.now(),
      isError: true
    })
    bufferManager.signalWorkAvailable()
  })
  
  // 4. Return immediately - main thread continues!
  return
}
```

#### 3. **HTTP Request Handler**
Buffer out-of-order requests:

```typescript
async function handleHttpRequest(req: Request): Promise<Response> {
  const incoming = parseRequest(req)
  const expectedEntry = validator.getCurrentEntry()
  
  // Case 1: This IS the next expected entry - process immediately
  if (matchesExpected(incoming, expectedEntry)) {
    const result = await processRequest(incoming, expectedEntry)
    return createHttpResponse(result)
  }
  
  // Case 2: Arrived early - buffer and return "queued" response
  const bufferKey = createBufferKey(incoming)
  bufferManager.incomingRequestBuffer.set(bufferKey, {
    request: incoming,
    timestamp: Date.now(),
    httpResponse: createDeferredPromise() // Will be resolved later
  })
  
  // Signal main thread that work is available
  bufferManager.signalWorkAvailable()
  
  // Return placeholder - actual response comes when main thread processes it
  return { status: 202, body: { queued: true, bufferKey } }
}
```

#### 4. **Main Processing Loop**
Continuously poll all sources:

```typescript
async function mainProcessingLoop() {
  while (orchestrator.isRunning) {
    // Check all sources for work (priority order)
    const workItem = await bufferManager.getNextWorkItem()
    
    switch (workItem.type) {
      case 'LOG_ENTRY':
        await processLogEntry(workItem.data)
        break
        
      case 'BUFFERED_REQUEST':
        await processBufferedRequest(workItem.data)
        break
        
      case 'BUFFERED_RESPONSE':
        await processBufferedResponse(workItem.data)
        break
        
      case 'NO_WORK':
        // Brief pause before polling again
        await sleep(10)
        break
    }
  }
}
```

### Data Flow Examples

#### Scenario: LSP Callback During Orch→LSP Call

```
Timeline:
---------

T0: Main Thread
    ├── Sees log entry: FlipKart-HardEligibility_REQUEST
    ├── Sends HTTP request to LSP (non-blocking)
    └── Immediately proceeds to next iteration
    
T1: Main Thread
    ├── Checks: Any buffered requests? → No
    ├── Checks: Any responses ready? → No
    ├── Checks: Next log entry? → LSP-FetchOfferRequest (but waiting for callback)
    └── Sleeps briefly, polls again
    
T2: LSP Receives HardEligibility request
    ├── Processes it
    └── Makes callback: POST /fetch-offer to Orch (FetchOfferRequest)
    
T3: HTTP Server (Orch)
    ├── Receives FetchOfferRequest
    ├── Checks current log position → Expecting HardEligibility_RESPONSE
    ├── Request doesn't match expected → BUFFER IT
    └── Returns 202 Accepted to LSP
    
T4: Main Thread (polling)
    ├── Checks: Any buffered requests? → YES! FetchOfferRequest
    ├── Processes buffered request (forwards to GW)
    └── Sends response back to LSP (from stored buffer)
    
T5: LSP
    ├── Gets FetchOffer response
    ├── Completes processing
    └── Returns HardEligibility_RESPONSE to Orch
    
T6: Main Thread
    ├── Checks: Any responses ready? → YES! HardEligibility_RESPONSE
    ├── Validates and processes it
    └── Marks entry as complete
```

### Key Design Decisions

#### 1. **Polling vs Event-Driven**
**Chosen: Hybrid Polling**
- Main thread polls in a loop with 10ms sleep
- Signal mechanism wakes it immediately when work arrives
- Prevents tight CPU spinning while maintaining responsiveness

#### 2. **HTTP Response Handling for Buffered Requests**
**Challenge**: When request is buffered, we need to:
- Acknowledge receipt (return 202)
- Later send the actual response when processed

**Solution**: Use deferred promises
```typescript
// When buffering
const deferred = createDeferredPromise()
buffer.httpResponse = deferred

// Later when processed
const result = await processBufferedRequest(buffer)
deferred.resolve(createHttpResponse(result))
```

#### 3. **Request Correlation**
**Problem**: How to match buffered requests with log entries?

**Solution**: Composite key matching
```typescript
interface BufferKey {
  logTag: string          // e.g., "LSP-FetchOfferRequest_REQUEST"
  source: string          // e.g., "LSP"
  destination: string     // e.g., "GW"
  requestId?: string      // If available
  loanAppId?: string      // For correlation
  lenderOrgId?: string    // For lender-specific calls
}

function createBufferKey(incoming: Request): string {
  return `${incoming.logTag}:${incoming.source}_${incoming.destination}:${incoming.requestId || ''}`
}
```

#### 4. **Timeout Handling**
**Requirements**:
- Requests can't wait forever
- Responses have SLA
- Deadlock detection

**Implementation**:
```typescript
interface BufferedItem {
  data: any
  timestamp: number
  timeoutMs: number
  
  isExpired(): boolean {
    return Date.now() - this.timestamp > this.timeoutMs
  }
}

// In main loop
for (const [key, item] of bufferManager.incomingRequestBuffer) {
  if (item.isExpired()) {
    logger.error(`Buffered request expired: ${key}`)
    item.reject(new Error('Request timeout'))
    bufferManager.incomingRequestBuffer.delete(key)
  }
}
```

### State Machine

```
                    ┌─────────────────────────────────────────┐
                    │                                         │
     ┌──────────────▼──────────────┐                         │
     │      IDLE/POLLING         │◄──────────────────────────┤
     └──────────────┬──────────────┘                         │
                    │                                         │
        ┌───────────┼───────────┐                            │
        ▼           ▼           ▼                            │
┌──────────┐ ┌──────────┐ ┌──────────┐                       │
│ LOG SEQ  │ │  BUFFER  │ │ RESPONSE │                       │
│  ENTRY   │ │ REQUEST  │ │  READY   │                       │
└────┬─────┘ └────┬─────┘ └────┬─────┘                       │
     │            │            │                              │
     ▼            ▼            ▼                              │
┌──────────┐ ┌──────────┐ ┌──────────┐                       │
│ Process  │ │ Check    │ │ Retrieve │                       │
│ Entry    │ │ Buffer   │ │ Result   │                       │
│ Send Req │ │ Keys     │ │ Complete │                       │
│ (async)  │ │ Process  │ │ Entry    │                       │
└────┬─────┘ └────┬─────┘ └────┬─────┘                       │
     │            │            │                              │
     └────────────┴────────────┘                              │
                    │                                         │
                    ▼                                         │
          ┌──────────────────┐                               │
          │ Advance Position │                               │
          └──────────────────┘                               │
                    │                                         │
                    └─────────────────────────────────────────┘
```

### Implementation Phases

#### Phase 1: Core Buffer Infrastructure
- [ ] Implement BufferManager with Map-based storage
- [ ] Add deferred promise utility
- [ ] Create signal/semaphore for wake notifications
- [ ] Implement buffer key generation

#### Phase 2: Non-Blocking HTTP Client
- [ ] Wrap existing http-client with non-blocking interface
- [ ] Implement response callback mechanism
- [ ] Add request timeout handling
- [ ] Store responses in buffer instead of returning

#### Phase 3: HTTP Server Modification
- [ ] Modify request handler to check buffer first
- [ ] Implement buffering logic for out-of-order requests
- [ ] Add deferred response mechanism
- [ ] Handle 202 Accepted pattern

#### Phase 4: Main Loop Refactoring
- [ ] Replace sequential processing with polling loop
- [ ] Implement work prioritization logic
- [ ] Add buffer cleanup/expiry handling
- [ ] Maintain backward compatibility

#### Phase 5: Integration & Testing
- [ ] Test the scenario: Orch→LSP→(callback)→Orch→GW
- [ ] Test multiple concurrent callbacks
- [ ] Test timeout scenarios
- [ ] Performance testing

### Code Skeleton

```typescript
// src/buffers/buffer-manager.ts
export class BufferManager {
  private incomingRequests = new Map<string, BufferedRequest>()
  private responses = new Map<string, BufferedResponse>()
  private pendingPromises = new Map<string, PendingPromise>()
  private workSignal = new Semaphore(0)
  
  async addIncomingRequest(request: IncomingRequest): Promise<WorkSignal> {
    const key = this.createKey(request)
    const deferred = createDeferred<HttpResponse>()
    
    this.incomingRequests.set(key, {
      request,
      deferred,
      timestamp: Date.now()
    })
    
    this.workSignal.release() // Signal main thread
    return { key, deferred }
  }
  
  async addResponse(requestId: string, response: any): Promise<void> {
    this.responses.set(requestId, {
      response,
      timestamp: Date.now()
    })
    this.workSignal.release()
  }
  
  async getNextWorkItem(): Promise<WorkItem> {
    await this.workSignal.acquire()
    
    // Priority 1: Check for buffered responses
    for (const [key, item] of this.responses) {
      return { type: 'RESPONSE', key, data: item }
    }
    
    // Priority 2: Check for buffered requests that match current position
    const currentEntry = validator.getCurrentEntry()
    for (const [key, item] of this.incomingRequests) {
      if (this.matchesCurrentEntry(item.request, currentEntry)) {
        this.incomingRequests.delete(key)
        return { type: 'BUFFERED_REQUEST', key, data: item }
      }
    }
    
    // Priority 3: Process next log entry
    if (currentEntry && !currentEntry.isProcessed) {
      return { type: 'LOG_ENTRY', data: currentEntry }
    }
    
    return { type: 'NO_WORK' }
  }
}

// src/orchestrator-async.ts
export class AsyncOrchestrator {
  private bufferManager = new BufferManager()
  
  async start(): Promise<void> {
    this.isRunning = true
    await this.mainLoop()
  }
  
  private async mainLoop(): Promise<void> {
    while (this.isRunning) {
      try {
        const work = await this.bufferManager.getNextWorkItem()
        
        switch (work.type) {
          case 'LOG_ENTRY':
            await this.processLogEntry(work.data)
            break
          case 'BUFFERED_REQUEST':
            await this.processBufferedRequest(work.data)
            break
          case 'BUFFERED_RESPONSE':
            await this.processBufferedResponse(work.data)
            break
        }
      } catch (error) {
        logger.error('Main loop error', error)
        // Continue processing - don't crash
      }
    }
  }
  
  private async processLogEntry(entry: LogEntry): Promise<void> {
    if (entry.source === 'APP' || entry.source === 'LENDER') {
      // Send request non-blocking
      await this.sendAsyncRequest(entry)
    } else {
      // Wait for request to arrive (already buffered or coming)
      // Just advance - the HTTP handler will deal with it
      this.validator.advance()
    }
  }
  
  private async sendAsyncRequest(entry: LogEntry): Promise<void> {
    // Fire and forget - response goes to buffer
    this.httpClient.send(entry).then(response => {
      this.bufferManager.addResponse(entry.requestId, response)
    })
    
    // Advance to next log entry immediately
    this.validator.advance()
  }
}
```

### Benefits

1. **No Deadlocks**: Main thread never blocks on network I/O
2. **Out-of-Order Handling**: Callbacks are buffered and processed when expected
3. **Concurrent Processing**: Multiple requests/responses handled simultaneously
4. **Backpressure Control**: Buffer sizes can be limited to prevent memory exhaustion
5. **Better Resource Utilization**: No idle waiting threads

### Risks & Mitigations

| Risk | Mitigation |
|------|------------|
| Memory exhaustion from large buffers | Limit buffer size, expire old entries |
| Starvation of log sequence | Priority queue favors log sequence |
| Race conditions | Proper locking on shared buffers |
| Debugging complexity | Detailed logging of buffer state transitions |
| Infinite polling | Sleep + signal pattern prevents CPU spin |

### Migration Path

1. Keep existing orchestrator as fallback
2. Add feature flag: `USE_ASYNC_BUFFER=true`
3. Gradually migrate test scenarios
4. Remove legacy code once stable

---

## Conclusion

This design transforms the orchestrator from a synchronous sequential processor to an event-driven system with buffering. It elegantly handles the callback scenario where LSP needs to call back to the orchestrator while the orchestrator is "mid-flow" processing a different request.

The key insight is: **Don't block the main thread on network I/O**. Instead, use buffers and a polling loop to multiplex between multiple sources of work.
