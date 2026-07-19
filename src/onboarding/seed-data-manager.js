import { makeRequest } from '../services/http-client.js';
import { logger } from '../utils/logger.js';
import { SERVICE_MAP, LENDER_ORG_ID_TO_ID_MAP } from '../config.js';
import { canonicalRequestLogTag } from '../services/log-tag-normalizer.js';
import { transformRequest } from '../services/request-transformer.js';

/**
 * Seed Data Manager - Handles onboarding of seed data to LSP
 */
export class SeedDataManager {
  constructor(logs) {
    this.logs = logs;
  }

  static getLogTag(log) {
    return log?.message?.log_tag || log?.log_tag || log?.logTag;
  }

  static normalizeLogTag(log) {
    return canonicalRequestLogTag(SeedDataManager.getLogTag(log) || '');
  }

  static parseMaybeJson(value) {
    if (typeof value !== 'string') {
      return value;
    }

    const trimmed = value.trim();
    if (!trimmed) {
      return value;
    }

    try {
      return JSON.parse(trimmed);
    } catch (_error) {
      return value;
    }
  }

  static getTraceRequest(log) {
    const rawTraceRequest =
      log?.payload ??
      log?.message?.trace_request ??
      log?.trace_request ??
      {};
    const parsedTraceRequest = SeedDataManager.parseMaybeJson(rawTraceRequest);
    return parsedTraceRequest && typeof parsedTraceRequest === 'object' ? parsedTraceRequest : {};
  }

  static getRequestPayload(log) {
    const traceRequest = SeedDataManager.getTraceRequest(log);
    return transformRequest(traceRequest, SeedDataManager.normalizeLogTag(log));
  }

  static normalizeLineSeedDataForOnboarding(lineSeedData, lenderOrgIdToIdMap = {}, preferredLenderOrgId = null) {
    if (!Array.isArray(lineSeedData) || !lineSeedData.length) {
      return [];
    }

    const lenderOrgIds = Object.keys(lenderOrgIdToIdMap || {});

    return lineSeedData.map(item => {
      const lineDetail = item?.lineDetail;
      if (!lineDetail || typeof lineDetail !== 'object') {
        return item;
      }

      const lenderOrgId =
        lineDetail?.lenderOrgId ||
        lineDetail?.lender_org_id ||
        lineDetail?.lenderCode ||
        lineDetail?.lender_code ||
        SeedDataManager.inferLenderOrgIdFromLineDetail(lineDetail);
      const replayLenderId = lineDetail?.lenderId || lineDetail?.lender_id || null;
      const fallbackLenderOrgId = !lenderOrgId
        ? (preferredLenderOrgId || (lenderOrgIds.length === 1 ? lenderOrgIds[0] : null))
        : null;
      const resolvedLenderOrgId = lenderOrgId || fallbackLenderOrgId;

      logger.info('Preserving line seed lenderId for onboarding so it stays consistent with config-seeded lender records', {
        lineDetailId: lineDetail?.lineDetailId || lineDetail?.line_detail_id || null,
        lenderOrgId: resolvedLenderOrgId,
        usedFallbackLenderOrgId: Boolean(fallbackLenderOrgId),
        lenderId: replayLenderId || null,
        configuredLenderIdForOrg: resolvedLenderOrgId && lenderOrgIdToIdMap
          ? lenderOrgIdToIdMap[resolvedLenderOrgId] || null
          : null
      });

      return {
        ...item,
        lineDetail: {
          ...lineDetail,
          lender_org_id: resolvedLenderOrgId,
          lenderOrgId: resolvedLenderOrgId,
          lender_id: replayLenderId,
          lenderId: replayLenderId
        }
      };
    });
  }

  static inferLenderOrgIdFromLineDetail(lineDetail) {
    const lenderExtensibleData =
      lineDetail?.lineDetailExtensibleData?.lenderExtensibleData ||
      lineDetail?.line_detail_extensible_data?.lender_extensible_data ||
      null;

    return (
      lenderExtensibleData?.lenderOrgId ||
      lenderExtensibleData?.lender_org_id ||
      lenderExtensibleData?.orgId ||
      lenderExtensibleData?.org_id ||
      null
    );
  }

  static buildCustomerSeedData({
    customerId,
    phone,
    pan,
    email,
    consents,
    riskDetails,
    firstName,
    middleName,
    lastName,
    dob,
    gender,
    maritalStatus,
    addresses = [],
    monthlyIncome,
    employmentType
  }) {
    const normalizeDob = value => {
      if (typeof value !== 'string') {
        return value || null;
      }

      const trimmed = value.trim();
      if (!trimmed) {
        return null;
      }

      const dmyMatch = trimmed.match(/^(\d{2})-(\d{2})-(\d{4})$/);
      if (dmyMatch) {
        const [, day, month, year] = dmyMatch;
        return `${year}-${month}-${day}`;
      }

      return trimmed;
    };

    const merchantScore = riskDetails?.cremo_score ?? null;
    const affluentScore = riskDetails?.affluent_score ?? null;
    const primaryAddress = addresses.find(addr => ['PERMANENT', 'DELIVERY'].includes(addr?.address_type)) || addresses[0] || null;
    const currentAddress = addresses.find(addr => addr?.address_type === 'CURRENT') || null;
    const toRupees = value => (value === null || value === undefined ? null : String(Number(value) / 100));
    const normalizeConsentFor = consent => {
      const consentFor =
        consent?.consentFor ||
        consent?.consent_for ||
        consent?.consent_type ||
        null;

      if (!consentFor) {
        return null;
      }

      return {
        ipAddress: consent?.ipAddress ?? consent?.ip_address ?? null,
        deviceInfo: consent?.deviceInfo ?? consent?.device_info ?? null,
        timestamp: consent?.timestamp ?? null,
        latitude: consent?.latitude ?? null,
        longitude: consent?.longitude ?? null,
        consentFor,
        consentMessage: consent?.consentMessage ?? consent?.consent_message ?? null
      };
    };
    const normalizedConsents = Array.isArray(consents)
      ? consents.map(normalizeConsentFor).filter(consent => consent?.consentFor && consent?.timestamp)
      : null;

    return {
      customerId: customerId || '',
      phone: phone || null,
      pan: pan || null,
      email: email || null,
      consent: normalizedConsents?.length ? normalizedConsents : null,
      metadata: {
        vintageData: {
          customerSince: null,
          totalLoanTaken: null,
          merchantScore,
          affluentScore,
          riskDetails: riskDetails || null
        }
      },
      firstName: firstName || null,
      fatherName: null,
      middleName: middleName || null,
      lastName: lastName || null,
      dob: normalizeDob(dob),
      gender: gender || null,
      maritalStatus: maritalStatus || null,
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
      monthlyIncome: toRupees(monthlyIncome),
      employmentType: employmentType || null,
      isIncomeConsentGiven: Array.isArray(consents)
        ? consents.some(consent =>
          ['MFI', 'mfi'].includes(consent?.consent_type) ||
          ['MFI', 'mfi'].includes(consent?.consentFor) ||
          ['MFI', 'mfi'].includes(consent?.consent_for)
        )
        : null,
      borrowerRelation: null,
      annualIncome: null,
      tradeName: null,
      getClientAuthToken: null,
      businessDetails: null,
      entity_category: 'INDIVIDUAL'
    };
  }

  static toSnakeCaseKey(key) {
    if (!key || typeof key !== 'string') {
      return key;
    }

    return key
      .replace(/([a-z0-9])([A-Z])/g, '$1_$2')
      .replace(/([A-Z]+)([A-Z][a-z])/g, '$1_$2')
      .toLowerCase();
  }

  static toSnakeCaseObject(value) {
    if (Array.isArray(value)) {
      return value.map(item => SeedDataManager.toSnakeCaseObject(item));
    }

    if (!value || typeof value !== 'object') {
      return value;
    }

    return Object.fromEntries(
      Object.entries(value).map(([key, nestedValue]) => [
        SeedDataManager.toSnakeCaseKey(key),
        SeedDataManager.toSnakeCaseObject(nestedValue)
      ])
    );
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
      const logTag = SeedDataManager.normalizeLogTag(log);
      if (logTag === 'LSP-Eligibility_REQUEST') {
        const traceRequest = SeedDataManager.getRequestPayload(log);
        const lenderOrgIds = traceRequest?.lenderOrgIds || traceRequest?.lender_org_ids;
        if (Array.isArray(lenderOrgIds)) {
          for (const id of lenderOrgIds) {
            if (id) orgIds.add(id);
          }
        }
      }

      if (['FlipKart-RealTimeEligibility_REQUEST', 'FlipKart-Eligibility_REQUEST'].includes(logTag)) {
        const traceRequest = SeedDataManager.getRequestPayload(log);
        const directLenderOrgId = SeedDataManager.inferLenderOrgId(log, traceRequest);
        if (directLenderOrgId) {
          orgIds.add(directLenderOrgId);
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

  static extractPreferredLenderOrgId(logs) {
    const preferredTags = [
      'FlipKart-RealTimeEligibility_REQUEST',
      'FlipKart-Eligibility_REQUEST',
      'LSP-Eligibility_REQUEST'
    ];

    for (const log of logs) {
      const logTag = SeedDataManager.normalizeLogTag(log);
      if (!preferredTags.includes(logTag)) {
        continue;
      }

      const traceRequest = SeedDataManager.getRequestPayload(log);
      const lenderOrgId = SeedDataManager.inferLenderOrgId(log, traceRequest);
      if (lenderOrgId) {
        logger.info('Extracted preferred lender org ID from replay logs', {
          logTag,
          lenderOrgId
        });
        return lenderOrgId;
      }
    }

    return null;
  }
  /**
   * Extract lineDetails from LSP-Eligibility_REQUEST logs
   */
  static extractLineDetails(logs) {
    for (const log of logs) {
      const logTag = SeedDataManager.normalizeLogTag(log);
      if (logTag === 'LSP-Eligibility_REQUEST') {
        const traceRequest = SeedDataManager.getRequestPayload(log);
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

  static inferLenderOrgId(log, traceRequest = {}) {
    const directLenderOrgId =
      log?.message?.lender_org_id ||
      log?.lender_org_id ||
      traceRequest?.lenderOrgId ||
      traceRequest?.lender_org_id ||
      traceRequest?.lenderCode ||
      traceRequest?.lender_code ||
      traceRequest?.eligibility?.lenderOrgId ||
      traceRequest?.eligibility?.lender_org_id ||
      null;

    if (directLenderOrgId) {
      return directLenderOrgId;
    }

    const loanApplicationId =
      traceRequest?.loanApplication?.loanApplicationId ||
      traceRequest?.loanApplicationId ||
      traceRequest?.loan_application_id ||
      null;

    if (typeof loanApplicationId === 'string') {
      const match = loanApplicationId.match(/-([A-Z_]+)$/);
      if (match?.[1]) {
        return match[1];
      }
    }

    const lenderRedirectionUrl = traceRequest?.lenderRedirectionUrl || traceRequest?.lender_redirection_url;
    if (typeof lenderRedirectionUrl === 'string') {
      const match = lenderRedirectionUrl.match(/\/([A-Z_]+)\/[^/]+$/);
      if (match?.[1]) {
        return match[1];
      }
    }

    return null;
  }

  static extractCustomerSeedData(logs) {
    const eligibleTags = new Set([
      'FlipKart-Eligibility_REQUEST',
      'FlipKart-LineOnboarding-Eligibility_REQUEST',
      'FlipKart-RealTimeEligibility_REQUEST'
    ]);

    for (const log of logs) {
      const logTag = SeedDataManager.normalizeLogTag(log);
      if (!eligibleTags.has(logTag)) {
        continue;
      }

      const traceRequest = SeedDataManager.getRequestPayload(log);
      const userDetails = traceRequest?.userDetails || traceRequest?.user_details;
      if (!userDetails) {
        continue;
      }

      const customerId =
        traceRequest?.customer_id ||
        traceRequest?.customerId ||
        log?.message?.merchant_customer_id ||
        log?.message?.order_id ||
        traceRequest?.order_id ||
        traceRequest?.orderId;
      const consents = traceRequest?.consents || null;
      const riskDetails = traceRequest?.risk_details || traceRequest?.riskDetails || null;
      const addresses = traceRequest?.address || [];

      const customerSeedData = SeedDataManager.buildCustomerSeedData({
        customerId,
        phone: userDetails?.mobile_number || userDetails?.phone,
        pan: userDetails?.pan_number || userDetails?.pan,
        email: userDetails?.email_id || userDetails?.email,
        consents,
        riskDetails,
        firstName: userDetails?.first_name,
        middleName: userDetails?.middle_name,
        lastName: userDetails?.last_name,
        dob: userDetails?.date_of_birth || userDetails?.dob,
        gender: userDetails?.gender,
        maritalStatus: userDetails?.marital_status,
        addresses,
        monthlyIncome: userDetails?.monthly_income,
        employmentType: userDetails?.employment_type
      });

      logger.info('Extracted customer seed data from eligibility logs', {
        logTag,
        customerId: customerSeedData.customerId,
        hasAddress: Boolean(addresses.length)
      });

      return customerSeedData.customerId ? customerSeedData : null;
    }

    for (const log of logs) {
      const logTag = SeedDataManager.normalizeLogTag(log);
      if (!['LSP-FetchOfferSync_REQUEST', 'FETCH_OFFER_SYNC_REQUEST', 'LSP-FetchOfferRequest_REQUEST'].includes(logTag)) {
        continue;
      }

      const traceRequest = SeedDataManager.getRequestPayload(log);
      const borrowerProfile = traceRequest?.loanApplication?.borrower?.profileDetails || {};
      const businessDetails = traceRequest?.loanApplication?.borrower?.businessDetails || {};
      const riskDetails = traceRequest?.loanApplication?.borrower?.vintageData?.riskDetails || null;
      const checkoutData = traceRequest?.loanApplication?.checkoutData || {};
      const orderDetails = checkoutData?.orderDetails || {};
      const metadata = checkoutData?.metadata || {};
      const customerSeedData = SeedDataManager.buildCustomerSeedData({
        customerId:
          metadata?.merchantCustomerId ||
          log?.message?.merchant_customer_id ||
          orderDetails?.orderId ||
          traceRequest?.loanApplication?.loanApplicationId,
        phone: borrowerProfile?.phone,
        pan: borrowerProfile?.pan,
        email: borrowerProfile?.email,
        consents: traceRequest?.loanApplication?.consentInfo || null,
        riskDetails,
        firstName: borrowerProfile?.firstName,
        middleName: borrowerProfile?.middleName,
        lastName: borrowerProfile?.lastName,
        dob: borrowerProfile?.dateOfBirth,
        gender: borrowerProfile?.gender,
        maritalStatus: borrowerProfile?.maritalStatus,
        addresses: (checkoutData?.addressDetails || []).map(address => ({
          address_line_1: address?.addressLine1 || address?.address_line_1,
          address_line_2: address?.addressLine2 || address?.address_line_2,
          city: address?.city,
          state: address?.state,
          pincode: address?.pinCode || address?.pincode,
          address_type: address?.addrType || address?.addressType || address?.address_type
        })),
        monthlyIncome: businessDetails?.monthlyIncome,
        employmentType: businessDetails?.employmentType
      });

      if (customerSeedData.customerId && customerSeedData.phone) {
        logger.info('Extracted customer seed data from fetch offer log fallback', {
          logTag,
          customerId: customerSeedData.customerId
        });
        return customerSeedData;
      }
    }

    logger.warn('No customer seed data found in eligibility logs');
    return null;
  }

  static extractLineSeedData(logs) {
    const lineSeedData = [];
    const seenLineDetailIds = new Set();
    const eligibleTags = new Set([
      'LSP-FetchOfferRequest_REQUEST',
      'LSP-FetchOfferSync_REQUEST',
      'FETCH_OFFER_SYNC_REQUEST'
    ]);

    for (const log of logs) {
      const logTag = SeedDataManager.normalizeLogTag(log);
      if (!eligibleTags.has(logTag)) {
        continue;
      }

      const traceRequest = SeedDataManager.getRequestPayload(log);
      const lenderOrgId = SeedDataManager.inferLenderOrgId(log, traceRequest);
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
        const lineDetailId = lineDetail?.lineDetailId || lineDetail?.line_detail_id || null;
        const seenKey = lineDetailId || `${log?.message?.request_id || log?.message?.client_request_id || 'unknown'}_${lineSeedData.length}`;

        if (!lineDetail || seenLineDetailIds.has(seenKey)) {
          continue;
        }

        seenLineDetailIds.add(seenKey);
        if (lineDetail.status === 'CREATED') {
          continue;
        }

        lineSeedData.push({
          lineDetail: {
            ...lineDetail,
            lenderOrgId
          },
          referenceId
        });
      }
    }

    logger.info('Extracted line seed data from fetch offer logs', {
      count: lineSeedData.length,
      lineDetailStatuses: lineSeedData.map(item => ({
        lineDetailId: item?.lineDetail?.lineDetailId || item?.lineDetail?.line_detail_id || null,
        status: item?.lineDetail?.status || null
      }))
    });

    return lineSeedData;
  }
  
  /**
   * Onboard seed data to LSP
   */
  async onboardSeedData(merchantId, lenderOrgIdToIdMap, lineDetails, customerSeedData, lineSeedData, preferredLenderOrgId = null) {
    logger.info('Onboarding seed data to LSP: ', { 
      baseUrl: SERVICE_MAP.LSP.baseUrl + '/art/configs/set', 
      merchantId, 
      lenderCount: Object.keys(lenderOrgIdToIdMap).length 
    });
    

    try {
      const seedPayload = {
        merchantId,
        lenderOrgIdToIdMap,
        lineDetails: Array.isArray(lineDetails) ? lineDetails : []
      };

      if (customerSeedData) {
        seedPayload.customerSeedData = SeedDataManager.toSnakeCaseObject(customerSeedData);
      }

      if (Array.isArray(lineSeedData) && lineSeedData.length > 0) {
        seedPayload.lineSeedData = SeedDataManager.normalizeLineSeedDataForOnboarding(
          lineSeedData,
          lenderOrgIdToIdMap,
          preferredLenderOrgId
        );
      }

      const response = await makeRequest(
        SERVICE_MAP.LSP.baseUrl,
        '/art/configs/set',
        'POST',
        seedPayload,
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
