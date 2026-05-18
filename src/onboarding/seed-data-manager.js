import { makeRequest } from '../services/http-client.js';
import { logger } from '../utils/logger.js';
import { SERVICE_MAP, LENDER_ORG_ID_TO_ID_MAP } from '../config.js';

/**
 * Seed Data Manager - Handles onboarding of seed data to LSP
 */
export class SeedDataManager {
  constructor(logs) {
    this.logs = logs;
  }

  /**
   * Extract merchantId from logs
   */
  static extractMerchantId(logs) {
    for (const log of logs) {
      const merchantId = log?.message?.merchant_id;
      const orderId = log?.message?.order_id;
      if (merchantId && orderId) {
        logger.info('Extracted merchantId and orderId from logs', { merchantId, orderId });
        return {merchantId, orderId};
      }
    }
    throw new Error('merchant_id not found in logs. Seed data onboarding requires merchant_id.');
  }

  /**
   * Extract lender org IDs from logs
   */
  static extractLenderOrgIds(logs) {
    const orgIds = new Set();
    for (const log of logs) {
      const logTag = log?.message?.log_tag || log?.log_tag;
      if (logTag === 'LSP-Eligibility_REQUEST') {
        const traceRequest = log?.message?.trace_request || log?.trace_request;
        const lenderOrgIds = traceRequest?.lenderOrgIds || traceRequest?.lender_org_ids;
        if (Array.isArray(lenderOrgIds)) {
          for (const id of lenderOrgIds) {
            if (id) orgIds.add(id);
          }
        }
      }
    }
    if (orgIds.size === 0) {
      logger.warn('No lender org IDs found in LSP-Eligibility_REQUEST logs');
      return {};
    }
    const lenderMap = {};
    for (const orgId of orgIds) {
      if (LENDER_ORG_ID_TO_ID_MAP[orgId]) {
        lenderMap[orgId] = LENDER_ORG_ID_TO_ID_MAP[orgId];
      } else {
        logger.warn('Lender org ID not found in mapping', { orgId });
      }
    }
    logger.info('Extracted lender org ID to ID mapping from logs', { 
      count: Object.keys(lenderMap).length, 
      orgIds: [...orgIds] 
    });
    return lenderMap;
  }
  /**
   * Extract lineDetails from LSP-Eligibility_REQUEST logs
   */
  static extractLineDetails(logs) {
    for (const log of logs) {
      // Check both root level and message level for log_tag
      const logTag = log?.message?.log_tag || log?.log_tag;
      if (logTag === 'LSP-Eligibility_REQUEST') {
        // Check both root level and message level for trace_request
        const traceRequest = log?.message?.trace_request || log?.trace_request;
        const lineDetails = traceRequest?.lineDetails || traceRequest?.line_details;
        if (Array.isArray(lineDetails) && lineDetails.length > 0) {
          logger.info('Extracted lineDetails from LSP-Eligibility_REQUEST logs', { 
            count: lineDetails.length 
          });
          return lineDetails;
        }
      }
    }
    logger.warn('No lineDetails found in LSP-Eligibility_REQUEST logs');
    return [];
  }
  
  /**
   * Onboard seed data to LSP
   */
  async onboardSeedData(merchantId, lenderOrgIdToIdMap, lineDetails) {
    logger.info('Onboarding seed data to LSP: ', { 
      baseUrl: SERVICE_MAP.LSP.baseUrl + '/art/configs/set', 
      merchantId, 
      lenderCount: Object.keys(lenderOrgIdToIdMap).length 
    });
    

    try {
      const response = await makeRequest(
        SERVICE_MAP.LSP.baseUrl,
        '/art/configs/set',
        'POST',
        { merchantId, lenderOrgIdToIdMap, lineDetails },
        null,
        null,
        null,
        merchantId,
        null,
        null,
        SERVICE_MAP.LSP.unixSocket
      );

      if (response.error) {
        throw new Error(`Seed data onboarding failed: ${response.message}`);
      }

      if (response.status !== 200) {
        throw new Error(`Seed data onboarding failed: HTTP ${response.status}`);
      }

      logger.info('Seed data onboarding successful', {
        merchantId,
        lenderMapSize: Object.keys(lenderOrgIdToIdMap).length,
        lineDetailsCount: lineDetails?.length || 0,
        status: response.status
      });

    } catch (error) {
      logger.error('Seed data onboarding failed', { merchantId, error: error.message });
      throw error;
    }
  }

  /**
   * Clear LSP data after journey completion
   */
  async clearLspData(merchantId, orderId) {
    logger.info('Clearing LSP data via art/data/clear');

    try {
      const response = await makeRequest(
        SERVICE_MAP.LSP.baseUrl,
        '/art/data/clear',
        'POST',
        { merchantId, orderId },
        null,
        null,
        null,
        merchantId,
        null,
        null,
        SERVICE_MAP.LSP.unixSocket
      );

      if (!response.error && response.status === 200) {
        logger.info('LSP data cleared successfully', { status: response.status });
      } else if (response.error) {
        logger.warn('Failed to clear LSP data', {
          error: response.message,
          status: response.status
        });
      } else {
        logger.warn('Failed to clear LSP data', {
          status: response.status,
          statusText: response.statusText
        });
      }
    } catch (error) {
      logger.error('Error clearing LSP data', { error: error.message });
    }
  }
}
