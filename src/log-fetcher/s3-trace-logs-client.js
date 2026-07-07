import { fetchS3TraceLogsByOrder } from './sources/s3-trace-logs-source.js';

export async function fetchS3TraceLogs(merchantId, orderId, sessionToken = null) {
  return fetchS3TraceLogsByOrder(merchantId, orderId, sessionToken);
}

export default fetchS3TraceLogs;
