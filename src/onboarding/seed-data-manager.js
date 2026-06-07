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

  static getLogTag(log) {
    return log?.message?.log_tag || log?.log_tag;
  }

  static getTraceRequest(log) {
    return log?.message?.trace_request || log?.trace_request || {};
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
      const logTag = SeedDataManager.getLogTag(log);
      if (logTag === 'LSP-Eligibility_REQUEST') {
        const traceRequest = SeedDataManager.getTraceRequest(log);
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
      const logTag = SeedDataManager.getLogTag(log);
      if (logTag === 'LSP-Eligibility_REQUEST') {
        const traceRequest = SeedDataManager.getTraceRequest(log);
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

  static extractCustomerSeedData(logs) {
    const eligibleTags = [
      'FlipKart-Eligibility_REQUEST',
      'FlipKart-LineOnboarding-Eligibility_REQUEST',
      'FlipKart-RealTimeEligibility_REQUEST'
    ];

    for (const log of logs) {
      const logTag = SeedDataManager.getLogTag(log);
      if (!eligibleTags.includes(logTag)) {
        continue;
      }

      const traceRequest = SeedDataManager.getTraceRequest(log);
      const userDetails = traceRequest?.userDetails || traceRequest?.user_details;
      if (!userDetails) {
        continue;
      }

      const customerId = traceRequest?.customer_id || traceRequest?.customerId || traceRequest?.order_id || traceRequest?.orderId;
      const consents = traceRequest?.consents || null;
      const riskDetails = traceRequest?.risk_details || traceRequest?.riskDetails || null;
      const merchantScore = riskDetails?.cremo_score ?? null;
      const affluentScore = riskDetails?.affluent_score ?? null;
      const addresses = traceRequest?.address || [];
      const primaryAddress = addresses.find(addr => ['PERMANENT', 'DELIVERY'].includes(addr?.address_type)) || null;
      const currentAddress = addresses.find(addr => addr?.address_type === 'CURRENT') || null;
      const toRupees = value => (value === null || value === undefined ? null : String(Number(value) / 100));

      const customerSeedData = {
        customerId: customerId || '',
        phone: userDetails?.mobile_number || userDetails?.phone || null,
        pan: userDetails?.pan_number || userDetails?.pan || null,
        email: userDetails?.email_id || userDetails?.email || null,
        consent: consents,
        metadata: {
          vintageData: {
            customerSince: null,
            totalLoanTaken: null,
            merchantScore,
            affluentScore,
            riskDetails
          }
        },
        firstName: userDetails?.first_name || null,
        fatherName: null,
        middleName: userDetails?.middle_name || null,
        lastName: userDetails?.last_name || null,
        dob: userDetails?.date_of_birth || userDetails?.dob || null,
        gender: userDetails?.gender || null,
        maritalStatus: userDetails?.marital_status || null,
        educationQualification: null,
        addressLine1: primaryAddress?.address_line_1 || null,
        addressLine2: primaryAddress?.address_line_2 || null,
        city: primaryAddress?.city || null,
        state: primaryAddress?.state || null,
        pincode: primaryAddress?.pincode || null,
        addressType: primaryAddress?.address_type || null,
        currAddressLine1: currentAddress?.address_line_1 || null,
        currAddressLine2: currentAddress?.address_line_2 || null,
        currCity: currentAddress?.city || null,
        currState: currentAddress?.state || null,
        currPincode: currentAddress?.pincode || null,
        currAddressType: currentAddress?.address_type || null,
        monthlyIncome: toRupees(userDetails?.monthly_income),
        employmentType: userDetails?.employment_type || null,
        isIncomeConsentGiven: Array.isArray(consents)
          ? consents.some(consent => consent?.consent_type === 'MFI')
          : null,
        borrowerRelation: null,
        annualIncome: null,
        tradeName: null,
        getClientAuthToken: null,
        businessDetails: null,
        entity_category: 'INDIVIDUAL'
      };

      logger.info('Extracted customer seed data from eligibility logs', {
        logTag,
        customerId: customerSeedData.customerId,
        hasAddress: Boolean(primaryAddress || currentAddress)
      });

      return customerSeedData.customerId ? customerSeedData : null;
    }

    logger.warn('No customer seed data found in eligibility logs');
    return null;
  }

  static extractLineSeedData(logs) {
    const lineSeedData = [];

    for (const log of logs) {
      const logTag = SeedDataManager.getLogTag(log);
      if (logTag !== 'LSP-FetchOfferRequest_REQUEST') {
        continue;
      }

      const traceRequest = SeedDataManager.getTraceRequest(log);
      const rawLineDetails = traceRequest?.lineDetails || traceRequest?.line_details || traceRequest?.lineDetail || null;
      const lineDetailsList = Array.isArray(rawLineDetails)
        ? rawLineDetails
        : rawLineDetails
          ? [rawLineDetails]
          : [];

      const referenceId =
        traceRequest?.loanApplication?.id ||
        traceRequest?.loanApplication?._id ||
        traceRequest?.loan_application_id ||
        traceRequest?.loanApplicationId ||
        null;

      for (const lineDetail of lineDetailsList) {
        if (!lineDetail || lineDetail.status === 'CREATED') {
          continue;
        }

        lineSeedData.push({
          lineDetail,
          referenceId
        });
      }
    }

    logger.info('Extracted line seed data from fetch offer request logs', {
      count: lineSeedData.length
    });

    return lineSeedData;
  }
  
  /**
   * Onboard seed data to LSP
   */
  async onboardSeedData(merchantId, lenderOrgIdToIdMap, lineDetails, customerSeedData, lineSeedData) {
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
        { merchantId, lenderOrgIdToIdMap, lineDetails, customerSeedData, lineSeedData },
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
        lineSeedCount: lineSeedData?.length || 0,
        customerSeeded: Boolean(customerSeedData),
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
