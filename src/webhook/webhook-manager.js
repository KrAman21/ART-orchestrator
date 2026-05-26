import { triggerWebhook } from '../services/http-client.js';
import { SERVICE_MAP } from '../config.js';

/**
 * WebhookManager - Handles webhook triggering logic for the orchestrator
 *
 * Responsibilities:
 * - Trigger webhooks to GW service
 * - Find and trigger APP->GW webhooks after response
 * - Manage pending post-response webhooks
 * - Track triggered webhooks to avoid duplicates
 */
export class WebhookManager {
  /**
   * @param {Object} dependencies - Dependencies for the webhook manager
   * @param {LogSequenceValidator} dependencies.validator - Log sequence validator instance
   * @param {Object} dependencies.logger - Logger instance
   * @param {Object} dependencies.config - Configuration object
   * @param {Set} dependencies.triggeredWebhooks - Set of triggered webhook indices
   */
  constructor({ validator, logger, config, triggeredWebhooks }) {
    this.validator = validator;
    this.logger = logger;
    this.config = config;
    this.triggeredWebhooks = triggeredWebhooks;

    // Track pending post-response webhooks by context key
    // Map<contextKey, Array<LogEntry>>
    this.pendingPostResponseWebhooks = new Map();
  }

  /**
   * Get service base URL
   * @param {string} serviceName - Service name (e.g., 'GW', 'LSP')
   * @returns {string} Base URL for the service
   */
  getServiceBaseUrl(serviceName) {
    const normalizedName = serviceName === 'GATEWAY' ? 'GW' :
      serviceName === 'CORE' ? 'LSP' : serviceName;

    return SERVICE_MAP[normalizedName]?.baseUrl;
  }

  getServiceUnixSocket(serviceName) {
    const normalizedName = serviceName === 'GATEWAY' ? 'GW' :
      serviceName === 'CORE' ? 'LSP' : serviceName;

    return SERVICE_MAP[normalizedName]?.unixSocket || null;
  }

  /**
   * Generate a context key for matching related entries
   * @param {LogEntry} entry - Log entry
   * @returns {string} Context key
   */
  getContextKey(entry) {
    const parts = [];
    if (entry.loanApplicationId) {
      parts.push(entry.loanApplicationId);
    }
    if (entry.lenderOrgId) {
      parts.push(entry.lenderOrgId);
    }
    // Use order_id as fallback correlation since it's present across multiple entries
    if (parts.length === 0 && entry.orderId) {
      return entry.orderId;
    }
    return parts.join(':') || entry.requestId || `${entry.index}`;
  }

  /**
   * Trigger pending post-response webhooks
   * Called after sending response back to the caller
   */
  async triggerPendingPostResponseWebhooks() {
    if (this.pendingPostResponseWebhooks && this.pendingPostResponseWebhooks.size > 0) {
      for (const [contextKey, webhooks] of this.pendingPostResponseWebhooks.entries()) {
        this.logger.info(`Triggering ${webhooks.length} post-response webhook(s) for ${contextKey}`);
        await this.triggerWebhooks(webhooks);
      }
      this.pendingPostResponseWebhooks.clear();
    }

    // Also find and trigger APP->GW webhooks that should fire after GW->APP response
    await this.triggerAppWebhooksAfterResponse();
  }

  /**
   * Find and trigger APP->GW webhooks that should fire after GW->APP response
   * This handles cases like FlipKart-EligibilityStatus after eligibility response
   */
  async triggerAppWebhooksAfterResponse() {
    // Find APP->GW webhook entries that haven't been processed yet
    const appWebhooks = [];
    const currentEntry = this.validator.getCurrentEntry();

    if (!currentEntry) return;

    // Look ahead for APP->GW webhooks
    const lookahead = this.validator.peekNext(100);
    for (const entry of lookahead) {
      if (entry.shouldSkip()) continue;

      // Stop if we hit a request that needs to be processed normally
      if (entry.isRequest && !entry.isExternalSource()) break;

      // Look for APP->GW webhooks
      if (entry.isWebhook() && entry.source === 'APP' && entry.destination === 'GW') {
        // Check if this webhook shares context with current flow
        const currentContextKey = this.getContextKey(currentEntry);
        const webhookContextKey = this.getContextKey(entry);

        if (currentContextKey === webhookContextKey || this.validator.contextsMatch(currentEntry, entry)) {
          appWebhooks.push(entry);
        }
      }
    }

    if (appWebhooks.length > 0) {
      this.logger.info(`Found ${appWebhooks.length} APP->GW webhook(s) to trigger after response`, {
        webhooks: appWebhooks.map(w => w.toString())
      });
      await this.triggerWebhooks(appWebhooks);
    }
  }

  /**
   * Trigger webhooks to GW
   * @param {Array<LogEntry>} webhooks - Array of webhook entries to trigger
   */
  async triggerWebhooks(webhooks) {
    for (const webhook of webhooks) {
      // Skip if already triggered
      if (this.triggeredWebhooks.has(webhook.index)) {
        this.logger.debug('Skipping already triggered webhook', { index: webhook.index });
        continue;
      }

      const lenderOrgId = webhook.lenderOrgId || webhook.payload?.lender_org_id;
      if (!lenderOrgId) {
        this.logger.warn('Cannot trigger webhook - no lender_org_id found', {
          webhook: webhook.toString()
        });
        continue;
      }

      try {
        const gwBaseUrl = this.getServiceBaseUrl('GW');
        const gwUnixSocket = this.getServiceUnixSocket('GW');
        const result = await triggerWebhook(
          gwBaseUrl,
          lenderOrgId,
          webhook.payload,
          {
            'x-request-id': webhook.requestId || `webhook-${webhook.index}`,
            'x-log-index': webhook.index.toString()
          },
          gwUnixSocket
        );

        if (result.success) {
          this.logger.info('Webhook triggered successfully', {
            index: webhook.index,
            lenderOrgId,
            status: result.status
          });
          this.triggeredWebhooks.add(webhook.index);
          // Mark webhook as processed in validator
          this.validator.markProcessed(webhook);
        } else {
          this.logger.error('Failed to trigger webhook', {
            index: webhook.index,
            error: result.message
          });
        }
      } catch (error) {
        this.logger.error('Exception triggering webhook', {
          index: webhook.index,
          error: error.message
        });
      }
    }
  }

  /**
   * Find webhooks for a LENDER call that should fire before or after the response
   * Delegates to the validator's method
   * @param {LogEntry} lenderRequestEntry - The LENDER request entry
   * @param {LogEntry} lenderResponseEntry - The LENDER response entry
   * @param {string} beforeOrAfter - 'before' or 'after'
   * @returns {Array<LogEntry>} Array of webhook entries
   */
  findWebhooksForLenderCall(lenderRequestEntry, lenderResponseEntry, beforeOrAfter = 'before') {
    return this.validator.findWebhooksForLenderCall(lenderRequestEntry, lenderResponseEntry, beforeOrAfter);
  }

  /**
   * Find webhooks that should be triggered AFTER the LENDER response
   * Delegates to the validator's method
   * @param {LogEntry} lenderResponseEntry - The LENDER->GW response entry
   * @param {LogEntry} gwToLspResponseEntry - The GW->LSP response entry
   * @returns {Array<LogEntry>} Array of webhook entries to trigger after response
   */
  findWebhooksAfterLenderResponse(lenderResponseEntry, gwToLspResponseEntry) {
    return this.validator.findWebhooksAfterLenderResponse(lenderResponseEntry, gwToLspResponseEntry);
  }

  /**
   * Store webhooks to trigger after sending response back to caller
   * @param {string} contextKey - Context key for grouping webhooks
   * @param {Array<LogEntry>} webhooks - Array of webhook entries
   */
  setPendingPostResponseWebhooks(contextKey, webhooks) {
    this.pendingPostResponseWebhooks = this.pendingPostResponseWebhooks || new Map();
    this.pendingPostResponseWebhooks.set(contextKey, webhooks);
  }

  /**
   * Check if there are pending post-response webhooks
   * @returns {boolean}
   */
  hasPendingPostResponseWebhooks() {
    return this.pendingPostResponseWebhooks && this.pendingPostResponseWebhooks.size > 0;
  }
}
