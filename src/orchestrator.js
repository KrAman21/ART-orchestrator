import { SERVICE_MAP, API_ENDPOINT_MAP, SKIP_DESTINATIONS, extractPayload, ENDPOINT_API_MAP } from './config.js';
import { makeRequest, checkHealth } from './services/http-client.js';
import { compareLog, findMatchingLog } from './services/comparator.js';
import { logger } from './utils/logger.js';

/**
 * ART Orchestrator - Replays production logs against local services
 */
class Orchestrator {
  constructor(merchantId) {
    this.outputList = [];
    this.results = {
      passed: 0,
      failed: 0,
      errors: [],
      processedLogs: []
    };
    this.merchantId = merchantId;
  }

  /**
   * Extract merchantId from logs by traversing and finding first non-null message.merchant_id
   */
  static extractMerchantId(logs) {
    for (const log of logs) {
      const merchantId = log?.message?.merchant_id;
      if (merchantId) {
        logger.info('Extracted merchantId from logs', { merchantId });
        return merchantId;
      }
    }
    throw new Error('merchantId not found in logs');
  }

  /**
   * Parse source_destination field to extract source and destination
   */
  parseSourceDestination(sourceDestination) {
    const parts = sourceDestination.split('_TO_');
    if (parts.length !== 2) {
      throw new Error(`Invalid source_destination format: ${sourceDestination}`);
    }
    return { source: parts[0], destination: parts[1] };
  }

  /**
   * Get API endpoint configuration based on (sourceDestination, logTag) combination
   */
  getEndpointConfig(sourceDestination, logTag) {
    const key = `${sourceDestination}|${logTag}`;
    const config = API_ENDPOINT_MAP[key];

    if (!config) {
      throw new Error(`No API mapping found for key: ${key}`);
    }

    return config;
  }

  /**
   * Get service configuration
   */
  getServiceConfig(serviceName) {
    const config = SERVICE_MAP[serviceName];
    if (!config) {
      throw new Error(`No service configuration found for: ${serviceName}`);
    }
    return config;
  }

  /**
   * Process a single log entry
   */
  async processLog(log, index, total) {
    const { message, xRequestId } = log;
    const logTag = message.log_tag;
    const sourceDestination = message.source_destination;
    const { source, destination } = this.parseSourceDestination(sourceDestination);

    // Skip logs where source is WRAPPER
    if (source === 'WRAPPER') {
      logger.logSkipped(source, 'Source is WRAPPER - ignoring trace log');
      return { success: true, step: 'skipped', reason: 'WRAPPER source' };
    }

    // Extract the appropriate payload based on log_tag (Request/Response)
    const payload = extractPayload(message, logTag);

    logger.logStep('processing', index, total, {
      logTag,
      source,
      destination,
      sourceDestination,
      hasPayload: payload !== null
    });

    // Step 1: Find and compare with expected output from previous responses
    const { found, log: expectedLog, index: foundIndex } = findMatchingLog(
      this.outputList,
      logTag,
      sourceDestination
    );

    logger.debug('OUTPUT_LIST state', {
      size: this.outputList.length,
      matchFound: found,
      matchIndex: foundIndex
    });

    if (found) {
      // Compare using the extracted payload
      const comparison = compareLog(expectedLog, payload, logTag);

      logger.logComparison(logTag, sourceDestination, comparison.match);

      if (!comparison.match) {
        return {
          success: false,
          step: 'comparison',
          error: 'Log comparison failed',
          details: comparison
        };
      }

      this.outputList.splice(foundIndex, 1);
    } else {
      logger.debug('No matching log found for comparison', { logTag, sourceDestination });
    }

    // Step 2: Skip service call if destination is APP or LENDER
    if (SKIP_DESTINATIONS.includes(destination)) {
      logger.logSkipped(destination, 'External service not available');
      return { success: true, step: 'skipped', destination };
    }

    // Step 3: Call the destination service
    const endpointConfig = this.getEndpointConfig(sourceDestination, logTag);
    const serviceConfig = this.getServiceConfig(endpointConfig.service);

    logger.logServiceCall(source, endpointConfig.service, endpointConfig.endpoint, endpointConfig.method);

    // Use extracted payload for the API call, fallback to full message if null
    const requestPayload = payload;

    const response = await makeRequest(
      serviceConfig.baseUrl,
      endpointConfig.endpoint,
      endpointConfig.method,
      requestPayload,
      xRequestId || message.request_id,
      sourceDestination,
      logTag,
      this.merchantId
    );

    // Step 4: Store response in OUTPUT_LIST
    // For mock responses, use the endpoint to look up the response log_tag and source_destination
    let responseLogTag = response.logTag;
    let responseSourceDestination = response.sourceDestination;

    if (response.endpoint && ENDPOINT_API_MAP[response.endpoint]) {
      const mapping = ENDPOINT_API_MAP[response.endpoint];
      responseLogTag = mapping.logTag;
      responseSourceDestination = mapping.sourceDestination;
    }

    const responseLog = {
      log_tag: responseLogTag,
      source_destination: responseSourceDestination,
      response: response,
      timestamp: new Date().toISOString()
    };

    this.outputList.push(responseLog);
    logger.logResponseStored(responseLogTag, responseSourceDestination, this.outputList.length);

    return { success: true, step: 'service_call', response };
  }

  /**
   * Verify all required services are healthy
   */
  async verifyServices() {
    logger.info('Verifying service health');

    for (const [name, config] of Object.entries(SERVICE_MAP)) {
      const isHealthy = await checkHealth(config);
      if (!isHealthy) {
        throw new Error(`Service ${name} is not healthy at ${config.baseUrl}`);
      }
    }

    logger.info('All services are healthy');
  }

  /**
   * Main replay method - processes all logs sequentially
   */
  async replay(logs) {
    try {
      await this.verifyServices();
      logger.logStart(logs.length);

      for (let i = 0; i < logs.length; i++) {
        const log = logs[i];
        const result = await this.processLog(log, i + 1, logs.length);

        this.results.processedLogs.push({
          logIndex: i,
          logTag: log.message?.log_tag,
          sourceDestination: log.message?.source_destination,
          result
        });

        if (!result.success) {
          this.results.failed++;
          this.results.errors.push({
            logIndex: i,
            log: log,
            error: result
          });

          logger.error('Replay failed', {
            logIndex: i + 1,
            error: result.error,
            details: result.details
          });

          break;
        }

        this.results.passed++;
      }

      await this.cleanup();
      return this.getSummary();

    } catch (error) {
      logger.logError(error, { phase: 'replay' });
      throw error;
    }
  }

  /**
   * Call cleanup API to clear journey data
   */
  async cleanup() {
    logger.info('Calling cleanup API');
    // TODO: Implement actual cleanup API call when endpoint is provided
    logger.info('Cleanup completed');
  }

  /**
   * Get summary of replay results
   */
  getSummary() {
    const summary = {
      total: this.results.passed + this.results.failed,
      passed: this.results.passed,
      failed: this.results.failed,
      success: this.results.failed === 0,
      outputListSize: this.outputList.length,
      errors: this.results.errors
    };

    logger.logComplete(summary);
    return summary;
  }
}

/**
 * Main entry point
 */
export async function runOrchestrator(logs) {
  // Extract merchantId from logs before processing
  const merchantId = Orchestrator.extractMerchantId(logs);
  const orchestrator = new Orchestrator(merchantId);
  return await orchestrator.replay(logs);
}

export default Orchestrator;
