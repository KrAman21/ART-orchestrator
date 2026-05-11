import { ReplayOrchestrator } from '../orchestrator.js';
import { BufferManager } from './buffer-manager.js';
import { NonBlockingHttpClient } from './non-blocking-http.js';
import { logger } from '../utils/logger.js';
import { transformRequest } from '../services/request-transformer.js';
import { getEndpointConfig } from '../config.js';

export class AsyncReplayOrchestrator extends ReplayOrchestrator {
  constructor(logs, config = {}) {
    super(logs, config);
    
    this.bufferManager = new BufferManager({
      defaultTimeoutMs: 60000  // Fixed at 60s regardless of config
    });
    
    this.httpClient = new NonBlockingHttpClient(this.bufferManager);
    
    this.isPolling = false;
    this.pollIntervalMs = config.pollIntervalMs || 800;
    this.shouldStop = false;
  }
  
  async start() {
    if (this.isRunning) {
      logger.warn('Async orchestrator already running');
      return { success: false, message: 'Already running' };
    }
    
    this.isRunning = true;
    this.shouldStop = false;
    
    const { merchantId, orderId } = AsyncReplayOrchestrator.extractMerchantId(this.logs);
    const lenderOrgIdToIdMap = AsyncReplayOrchestrator.extractLenderOrgIds(this.logs);
    
    await this.clearLspData(merchantId, orderId);
    await this.onboardSeedData(merchantId, lenderOrgIdToIdMap);
    
    logger.info('Async replay orchestrator started', {
      totalLogs: this.logs.length,
      validator: this.validator.getProgress()
    });
    
    this.pollingLoop();
    
    return {
      success: true,
      message: 'Async orchestrator started'
    };
  }
  
  async pollingLoop() {
    this.isPolling = true;
    let consecutiveNoWork = 0;
    const maxBackoffMs = 1000;
    
    while (this.isRunning && !this.shouldStop) {
      try {
        const didWork = await this.processOneCycle();
        
        if (!didWork) {
          consecutiveNoWork++;
          const backoffMs = Math.min(this.pollIntervalMs * Math.pow(1.5, consecutiveNoWork), maxBackoffMs);
          await this.sleep(backoffMs);
        } else {
          consecutiveNoWork = 0;
        }
        
        if (this.validator.isComplete()) {
          logger.info('All logs processed');
          break;
        }
      } catch (error) {
        logger.error('Error in polling loop', { error: error.message });
        await this.sleep(this.pollIntervalMs);
      }
    }
    
    this.isPolling = false;
    logger.info('Polling loop ended');
  }
  
  async processOneCycle() {
    let didWork = false;
    
    didWork = await this.checkBufferedResponses() || didWork;
    
    didWork = await this.checkBufferedIncomingRequests() || didWork;
    
    didWork = await this.processNextLogEntry() || didWork;
    
    return didWork;
  }
  
  async checkBufferedResponses() {
    const currentEntry = this.validator.getCurrentEntry();
    
    if (!currentEntry || !currentEntry.isResponse) {
      return false;
    }
    
    // Find the corresponding request entry (should be the previous unprocessed request)
    const requestEntry = this.findCorrespondingRequest(currentEntry);
    if (!requestEntry) {
      logger.debug('No corresponding request found for response', {
        responseEntry: currentEntry.toString()
      });
      return false;
    }
    
    // Use the request's requestId to lookup in buffer
    const requestId = requestEntry.requestId;
    if (!requestId) {
      return false;
    }
    
    const buffered = this.bufferManager.getResponse(requestId);
    if (!buffered) {
      logger.debug('Response not yet in buffer', {
        requestId,
        responseEntry: currentEntry.toString()
      });
      return false;
    }
    
    logger.info('Found buffered response for current entry', {
      entry: currentEntry.toString(),
      requestId,
      requestEntry: requestEntry.toString()
    });
    
    if (buffered.isError) {
      await this.fail(`Buffered response error: ${buffered.response.message}`);
      return true;
    }
    
    const comparison = this.comparePayloads(
      currentEntry.payload,
      buffered.response.data,
      currentEntry.logTag
    );
    
    if (!comparison.match) {
      await this.fail('Buffered response comparison failed', comparison.differences);
      return true;
    }
    
    this.validator.advance();
    this.recordSuccess('buffered_response_validation', currentEntry);
    
    logger.info('Buffered response validated and processed', {
      entry: currentEntry.toString()
    });
    
    return true;
  }
  
  async checkBufferedIncomingRequests() {
    const currentEntry = this.validator.getCurrentEntry();
    
    if (!currentEntry || !currentEntry.isRequest) {
      return false;
    }
    
    const buffered = this.bufferManager.findMatchingRequest(currentEntry);
    if (!buffered) {
      return false;
    }
    
    logger.info('Found buffered incoming request matching current entry', {
      entry: currentEntry.toString(),
      bufferKey: buffered.key
    });
    
    try {
      const result = await this.processBufferedIncomingRequest(buffered, currentEntry);
      // Result is immediate - worker thread handles the actual forward
      // The deferred will be resolved by the worker when forward completes
      return true;
    } catch (error) {
      buffered.deferred.reject(error);
      throw error;
    }
  }
  
  async processBufferedIncomingRequest(buffered, expectedEntry) {
    const incoming = buffered.request;
    
    logger.info('Processing buffered incoming request', {
      entry: expectedEntry.toString(),
      bufferKey: buffered.key
    });
    
    const comparison = this.comparePayloads(expectedEntry.payload, incoming.payload, incoming.logTag);
    
    if (!comparison.match) {
      throw new Error(`Payload comparison failed: ${JSON.stringify(comparison.differences)}`);
    }
    
    this.validator.advance();
    this.recordSuccess('buffered_request_validation', expectedEntry);
    
    // Spawn async worker to handle the forward - don't block main thread
    this.spawnForwardWorker(buffered, expectedEntry);
    
    // Return immediately - main thread continues to next log entry
    return { success: true, async: true, message: 'Forward spawned to worker thread' };
  }
  
  spawnForwardWorker(buffered, expectedEntry) {
    const incoming = buffered.request;
    const deferred = buffered.deferred;
    
    logger.info('Spawning forward worker thread', {
      entry: expectedEntry.toString(),
      requestId: incoming.requestId
    });
    
    // Run forward in background - don't block main polling loop
    this.forwardToDestination(incoming, expectedEntry)
      .then(response => {
        logger.info('Forward worker completed successfully', {
          requestId: incoming.requestId,
          entry: expectedEntry.toString()
        });
        deferred.resolve(response);
      })
      .catch(error => {
        logger.error('Forward worker failed', {
          requestId: incoming.requestId,
          error: error.message
        });
        deferred.reject(error);
      });
  }
  
  async processNextLogEntry() {
    const entry = this.validator.getCurrentEntry();
    
    if (!entry) {
      return false;
    }
    
    // Skip already processed entries (e.g., GATEWAY->LENDER handled immediately)
    if (this.validator.processedIndices.has(entry.index)) {
      logger.debug('Entry already processed, skipping', {
        entry: entry.toString()
      });
      this.validator.advance();
      return true;
    }
    
    if (entry.shouldSkip()) {
      this.validator.markProcessed(entry);
      return true;
    }
    
    const isInternalLspCall = entry.sourceDestination === 'CORE_EULER' ||
                              entry.sourceDestination === 'CORE_THEMIS' ||
                              (entry.source === 'CORE' && entry.destination === 'EULER') ||
                              (entry.source === 'CORE' && entry.destination === 'THEMIS');
    
    if (isInternalLspCall && entry.isRequest) {
      await this.mockInternalLspRequest(entry);
      return true;
    }
    
    const orchestratorInitiatedSources = ['APP', 'LENDER', 'EULER', 'THEMIS'];
    const shouldOrchestratorInitiate = orchestratorInitiatedSources.includes(entry.source);
    
    if (shouldOrchestratorInitiate && entry.isRequest) {
      await this.triggerExternalRequestAsync(entry);
      return true;
    } else if (entry.isRequest) {
      logger.debug('Waiting for incoming request from service', {
        entry: entry.toString()
      });
      return false;
    }
    
    if (entry.isResponse) {
      logger.debug('Current entry is a response, waiting for it to arrive via buffer', {
        entry: entry.toString()
      });
      return false;
    }
    
    return false;
  }
  
  async triggerExternalRequestAsync(entry) {
    try {
      const api = this.getApiForLogTag(entry.logTag);
      const endpointConfig = getEndpointConfig(entry.sourceDestination, entry.logTag);
      const customHeaders = endpointConfig?.headers || {};
      const service = endpointConfig?.service || entry.destination;
      
      const transformedPayload = transformRequest(entry.payload, entry.logTag);
      
      logger.info('ORCH_SENDING_ASYNC', {
        destination: service,
        api,
        logTag: entry.logTag,
        requestId: entry.requestId
      });
      
      this.httpClient.send(
        this.getServiceBaseUrl(service),
        api,
        'POST',
        transformedPayload,
        entry.requestId,
        entry.sourceDestination,
        entry.logTag,
        null,
        customHeaders,
        entry.index
      );
      
      this.validator.advance();
      
      logger.info('Async request sent, main thread continuing', {
        requestId: entry.requestId,
        logTag: entry.logTag
      });
      
    } catch (error) {
      logger.error('Failed to trigger async external request', {
        entry: entry.toString(),
        error: error.message
      });
      this.recordFailure('async_external_request_trigger', entry, error.message);
    }
  }
  
  async handleIncomingRequest(incoming) {
    logger.info('ASYNC_ORCH_RECEIVING', {
      source: incoming.source,
      destination: incoming.destination,
      api: incoming.api,
      requestId: incoming.requestId,
      logTag: incoming.logTag
    });
    
    // Handle GATEWAY->LENDER requests specially
    // Immediately respond with expected payload and mark entries as processed
    // Main thread will skip already processed entries
    if (incoming.source === 'GATEWAY' && incoming.destination === 'LENDER') {
      return await this.handleGatewayLenderRequestImmediate(incoming);
    }
    
    // Handle Themis-Eligibility batch requests specially
    // These come from GATEWAY to LSP/THEMIS and should be processed in batch by lenderOrgId
    if (incoming.logTag === 'Themis-Eligibility_REQUEST' && 
        incoming.source === 'GATEWAY' && 
        (incoming.destination === 'LENDER' || incoming.destination === 'LSP' || incoming.destination === 'THEMIS')) {
      logger.info('Handling Themis-Eligibility batch request asynchronously', {
        lenderOrgId: incoming.lenderOrgId,
        requestId: incoming.requestId
      });
      return await this.handleThemisEligibilityBatchAsync(incoming);
    }
    
    const currentEntry = this.validator.getCurrentEntry();
    
    if (currentEntry && this.matchesCurrentEntry(incoming, currentEntry)) {
      return await super.handleIncomingRequest(incoming);
    }
    
    const buffered = await this.bufferManager.addIncomingRequest(incoming);
    
    logger.info('Request buffered for async processing', {
      requestId: incoming.requestId,
      bufferKey: buffered.key
    });
    
    try {
      const result = await buffered.deferred.promise;
      return result;
    } catch (error) {
      logger.error('Buffered request failed', { error: error.message });
      return {
        success: false,
        error: error.message
      };
    }
  }
  
  async handleThemisEligibilityBatchAsync(incoming) {
    logger.info('Processing Themis-Eligibility batch asynchronously', {
      lenderOrgId: incoming.lenderOrgId,
      requestId: incoming.requestId
    });
    
    // Find the matching request and response entries by lenderOrgId
    const allThemisEntries = this.validator.entries.filter(entry =>
      entry.logTag === 'Themis-Eligibility_REQUEST' &&
      entry.source === 'GATEWAY' &&
      (entry.destination === 'LENDER' || entry.destination === 'LSP' || entry.destination === 'THEMIS') &&
      !this.validator.processedIndices.has(entry.index)
    );
    
    let requestEntry = null;
    let responseEntry = null;
    
    for (const entry of allThemisEntries) {
      if (entry.lenderOrgId === incoming.lenderOrgId) {
        requestEntry = entry;
        responseEntry = this.validator.entries.find(e =>
          e.logTag === 'Themis-Eligibility_RESPONSE' &&
          e.sourceDestination === 'GATEWAY_THEMIS' &&
          e.lenderOrgId === incoming.lenderOrgId &&
          !this.validator.processedIndices.has(e.index)
        );
        
        if (responseEntry) {
          this.validator.processedIndices.add(entry.index);
          this.validator.processedIndices.add(responseEntry.index);
          this.recordSuccess('themis_batch_request_validation', entry);
          this.recordSuccess('themis_batch_response_validation', responseEntry);
          logger.info('Marked Themis-Eligibility pair as processed', {
            requestIndex: entry.index,
            responseIndex: responseEntry.index,
            lenderOrgId: entry.lenderOrgId
          });
        }
        break;
      }
    }
    
    if (!responseEntry) {
      logger.error('No matching Themis-Eligibility response found', {
        lenderOrgId: incoming.lenderOrgId,
        requestId: incoming.requestId
      });
      return {
        success: false,
        error: 'No matching response found'
      };
    }
    
    // Compare request payload
    const comparison = this.comparePayloads(requestEntry.payload, incoming.payload, incoming.logTag);
    if (!comparison.match) {
      await this.fail('Themis-Eligibility payload mismatch', comparison.differences);
      return {
        success: false,
        error: 'Payload mismatch'
      };
    }
    
    logger.info('Themis-Eligibility batch request validated, returning response', {
      lenderOrgId: incoming.lenderOrgId
    });
    
    return {
      success: true,
      payload: responseEntry.payload,
      lenderOrgId: incoming.lenderOrgId
    };
  }
  
  async handleGatewayLenderRequestImmediate(incoming) {
    logger.info('Handling GATEWAY->LENDER request immediately', {
      logTag: incoming.logTag
    });
    
    // Find matching request entry by logTag only
    const requestEntry = this.validator.entries.find(entry =>
      entry.logTag === incoming.logTag &&
      entry.source === 'GATEWAY' &&
      entry.destination === 'LENDER' &&
      !this.validator.processedIndices.has(entry.index)
    );
    
    if (!requestEntry) {
      logger.warn('No matching GATEWAY->LENDER request entry found, buffering', {
        logTag: incoming.logTag
      });
      // Fall back to normal buffering
      const buffered = await this.bufferManager.addIncomingRequest(incoming);
      return await buffered.deferred.promise;
    }
    
    // Find corresponding response
    const responseEntry = this.findCorrespondingResponse(requestEntry);
    if (!responseEntry) {
      logger.warn('No corresponding response found for GATEWAY->LENDER request', {
        requestEntry: requestEntry.toString()
      });
      return {
        success: false,
        error: 'No corresponding response found'
      };
    }
    
    // Validate payload
    const comparison = this.comparePayloads(requestEntry.payload, incoming.payload, incoming.logTag);
    if (!comparison.match) {
      logger.error('GATEWAY->LENDER payload mismatch', {
        differences: comparison.differences
      });
      return {
        success: false,
        error: 'Payload mismatch'
      };
    }
    
    // Mark both entries as processed
    this.validator.processedIndices.add(requestEntry.index);
    this.validator.processedIndices.add(responseEntry.index);
    this.recordSuccess('gateway_lender_request', requestEntry);
    this.recordSuccess('gateway_lender_response', responseEntry);
    
    logger.info('GATEWAY->LENDER request processed immediately', {
      requestIndex: requestEntry.index,
      responseIndex: responseEntry.index,
      logTag: incoming.logTag
    });
    
    // Return response immediately
    return {
      success: true,
      payload: responseEntry.payload
    };
  }
  
  findCorrespondingRequest(responseEntry) {
    const expectedSource = responseEntry.destination;
    const expectedDest = responseEntry.source;
    const responseTag = responseEntry.logTag.replace(/_RESPONSE$/, '').replace(/_OUTGOING$/, '');
    
    for (let i = this.validator.currentIndex - 1; i >= 0; i--) {
      const entry = this.validator.entries[i];
      if (!entry.isRequest) continue;
      
      const requestTag = entry.logTag.replace(/_REQUEST$/, '').replace(/_INCOMING$/, '');
      
      if (requestTag === responseTag && 
          entry.source === expectedSource && 
          entry.destination === expectedDest) {
        if (entry.loanApplicationId && responseEntry.loanApplicationId) {
          if (entry.loanApplicationId !== responseEntry.loanApplicationId) continue;
        }
        if (entry.lenderOrgId && responseEntry.lenderOrgId) {
          if (entry.lenderOrgId !== responseEntry.lenderOrgId) continue;
        }
        return entry;
      }
    }
    return null;
  }
  
  matchesCurrentEntry(incoming, currentEntry) {
    if (!currentEntry.isRequest) return false;
    if (incoming.logTag !== currentEntry.logTag) return false;
    if (incoming.source !== currentEntry.source) return false;
    if (incoming.destination !== currentEntry.destination) return false;
    return true;
  }
  
  sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
  }
  
  getStats() {
    return {
      ...super.getResults(),
      bufferStats: this.bufferManager.getStats(),
      activeHttpRequests: this.httpClient.getActiveRequestCount(),
      isPolling: this.isPolling
    };
  }
  
  async stop() {
    this.shouldStop = true;
    
    while (this.isPolling) {
      await this.sleep(10);
    }
    
    this.bufferManager.clear();
    this.httpClient.cleanup(0);
    
    await super.stop();
    
    logger.info('Async orchestrator stopped');
  }
}
