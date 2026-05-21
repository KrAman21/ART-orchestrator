import { logger } from '../utils/logger.js';
import { LSP_API_CONFIG } from '../config.js';

const DEFAULT_BASE_URL = LSP_API_CONFIG.baseUrl || 'https://integ-expresscheckout-api.juspay.in';

export async function fetchS3TraceLogs(merchantId, orderId, sessionToken = null) {
  const effectiveSessionToken = sessionToken || LSP_API_CONFIG.sessionToken;
  
  if (!effectiveSessionToken) {
    logger.error('Session token not provided for S3 Trace Logs API');
    return {
      success: false,
      error: 'Session token not provided',
      logs: [],
      count: 0
    };
  }
  
  logger.info('Fetching S3 Trace Logs', {
    merchantId,
    orderId,
    hasSessionToken: true
  });

  const id = `${merchantId}/${orderId}`;
  const encodedId = encodeURIComponent(id);
  const endpoint = `/credit/api/v3.3/dashboard/getS3TraceLogs?lookup_on=SECONDARY&id=${encodedId}&id_type=merchant_id/order_id`;
  const url = `${DEFAULT_BASE_URL}${endpoint}`;

  try {
    const response = await fetch(url, {
      method: 'GET',
      headers: {
        'Content-Type': 'application/json',
        'Accept': 'application/json',
        'session-token': effectiveSessionToken
      }
    });

    if (!response.ok) {
      const errorText = await response.text();
      logger.error('Failed to fetch S3 Trace Logs', {
        status: response.status,
        statusText: response.statusText,
        merchantId,
        orderId,
        error: errorText
      });
      return {
        success: false,
        error: `HTTP error! status: ${response.status}`,
        message: errorText,
        logs: [],
        count: 0
      };
    }

    const data = await response.json();

    const logs = data.result && Array.isArray(data.result) 
      ? data.result 
      : (Array.isArray(data) && data.length > 0 && data[0]?.result 
        ? data[0].result 
        : (Array.isArray(data) ? data : []));

    // Filter out encrypted logs - they cannot be meaningfully compared
    const filteredLogs = logs.filter(log => {
      const logTag = log.log_tag || log.logTag || '';
      return !logTag.includes('_ENCRYPTED');
    });

    const excludedCount = logs.length - filteredLogs.length;
    if (excludedCount > 0) {
      logger.info('Filtered out encrypted logs from S3 Trace Logs', {
        totalFetched: logs.length,
        excludedCount,
        remainingCount: filteredLogs.length
      });
    }

    logger.info('Successfully fetched S3 Trace Logs', {
      merchantId,
      orderId,
      logCount: filteredLogs.length
    });

    return {
      success: true,
      logs: filteredLogs,
      count: filteredLogs.length
    };

  } catch (error) {
    logger.error('Exception while fetching S3 Trace Logs', {
      merchantId,
      orderId,
      error: error.message,
      stack: error.stack
    });

    return {
      success: false,
      error: error.message,
      logs: [],
      count: 0
    };
  }
}

export default fetchS3TraceLogs;
