import { SERVICE_MAP, API_ENDPOINT_MAP, SKIP_DESTINATIONS } from './config.js';
import { makeRequest, checkHealth } from './services/http-client.js';
import { compareLog, findMatchingLog } from './services/comparator.js';

/**
 * ART Orchestrator - Replays production logs against local services
 */
class Orchestrator {
  constructor() {
    this.outputList = []; // Stores responses from service calls
    this.results = {
      passed: 0,
      failed: 0,
      errors: [],
      processedLogs: []
    };
  }

  /**
   * Parse source_destination field to extract source and destination
   * e.g., "LSP_TO_GW" -> { source: "LSP", destination: "GW" }
   */
  parseSourceDestination(sourceDestination) {
    const parts = sourceDestination.split('_TO_');
    if (parts.length !== 2) {
      throw new Error(`Invalid source_destination format: ${sourceDestination}`);
    }
    return { source: parts[0], destination: parts[1] };
  }

  /**
   * Get API endpoint configuration based on source_destination and log_tag
   */
  getEndpointConfig(sourceDestination, logTag) {
    const mapping = API_ENDPOINT_MAP[sourceDestination];
    if (!mapping) {
      throw new Error(`No API mapping found for source_destination: ${sourceDestination}`);
    }

    const config = mapping[logTag];
    if (!config) {
      throw new Error(`No API mapping found for log_tag: ${logTag} in ${sourceDestination}`);
    }

    return config;
  }

  /**
   * Get service configuration based on service name
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
  async processLog(log) {
    const { message, log_tag: logTag, source_destination: sourceDestination, xRequestId } = log;
    const { source, destination } = this.parseSourceDestination(sourceDestination);

    console.log(`Processing log: ${logTag} | ${source} -> ${destination}`);

    // Step 1: Find and compare with expected output from previous responses
    const { found, log: expectedLog, index } = findMatchingLog(
      this.outputList,
      logTag,
      sourceDestination
    );

    if (found) {
      // Compare with expected response
      const comparison = compareLog(expectedLog, message);

      if (!comparison.match) {
        return {
          success: false,
          step: 'comparison',
          error: 'Log comparison failed',
          details: comparison
        };
      }

      // Remove the matched log from outputList
      this.outputList.splice(index, 1);
      console.log(`  Comparison passed for ${logTag}`);
    }

    // Step 2: Skip service call if destination is APP or LENDER
    if (SKIP_DESTINATIONS.includes(destination)) {
      console.log(`  Skipping service call for external destination: ${destination}`);
      return { success: true, step: 'skipped', destination };
    }

    // Step 3: Call the destination service
    const endpointConfig = this.getEndpointConfig(sourceDestination, logTag);
    const serviceConfig = this.getServiceConfig(destination);

    console.log(`  Calling ${destination} at ${endpointConfig.method} ${endpointConfig.endpoint}`);

    const response = await makeRequest(
      serviceConfig.baseUrl,
      endpointConfig.endpoint,
      endpointConfig.method,
      message,
      xRequestId || message.request_id
    );

    // Step 4: Store response in OUTPUT_LIST
    const responseLog = {
      log_tag: logTag,
      source_destination: sourceDestination,
      response: response,
      timestamp: new Date().toISOString()
    };

    this.outputList.push(responseLog);
    console.log(`  Response stored in OUTPUT_LIST`);

    return { success: true, step: 'service_call', response };
  }

  /**
   * Verify all required services are healthy
   */
  async verifyServices() {
    console.log('Verifying service health...\n');

    for (const [name, config] of Object.entries(SERVICE_MAP)) {
      const isHealthy = await checkHealth(config);
      if (!isHealthy) {
        throw new Error(`Service ${name} is not healthy at ${config.baseUrl}`);
      }
      console.log(`  ${name}: OK`);
    }

    console.log('All services are healthy\n');
  }

  /**
   * Main replay method - processes all logs sequentially
   */
  async replay(logs) {
    try {
      // Step 1: Verify services are healthy
      await this.verifyServices();

      console.log(`Starting replay of ${logs.length} logs...\n`);

      // Step 2: Process each log sequentially
      for (let i = 0; i < logs.length; i++) {
        const log = logs[i];
        console.log(`[${i + 1}/${logs.length}]`);

        const result = await this.processLog(log);

        this.results.processedLogs.push({
          logIndex: i,
          logTag: log.log_tag,
          sourceDestination: log.source_destination,
          result
        });

        if (!result.success) {
          this.results.failed++;
          this.results.errors.push({
            logIndex: i,
            log: log,
            error: result
          });

          console.log(`\nReplay failed at log ${i + 1}`);
          console.log('Error:', result.error);
          console.log('Details:', JSON.stringify(result.details, null, 2));

          // Break the flow as per requirements
          break;
        }

        this.results.passed++;
        console.log(''); // Empty line for readability
      }

      // Step 3: Call cleanup API after all logs processed
      await this.cleanup();

      return this.getSummary();

    } catch (error) {
      console.error('Orchestrator error:', error.message);
      throw error;
    }
  }

  /**
   * Call cleanup API to clear journey data
   */
  async cleanup() {
    console.log('Calling cleanup API...');
    // TODO: Implement actual cleanup API call when endpoint is provided
    console.log('Cleanup completed\n');
  }

  /**
   * Get summary of replay results
   */
  getSummary() {
    return {
      total: this.results.passed + this.results.failed,
      passed: this.results.passed,
      failed: this.results.failed,
      success: this.results.failed === 0,
      outputListSize: this.outputList.length,
      errors: this.results.errors
    };
  }
}

/**
 * Main entry point
 */
export async function runOrchestrator(logs) {
  const orchestrator = new Orchestrator();
  return await orchestrator.replay(logs);
}

export default Orchestrator;
