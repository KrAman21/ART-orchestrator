import { BatchLogFetcher, fetchLogsForOrders } from './batch-processor.js';
import { SequentialLogProcessor, processOrdersSequentially } from './sequential-processor.js';
import fetchS3TraceLogs from './s3-trace-logs-client.js';

export { BatchLogFetcher, fetchLogsForOrders, SequentialLogProcessor, processOrdersSequentially, fetchS3TraceLogs };

export default {
  BatchLogFetcher,
  fetchLogsForOrders,
  SequentialLogProcessor,
  processOrdersSequentially,
  fetchS3TraceLogs
};
