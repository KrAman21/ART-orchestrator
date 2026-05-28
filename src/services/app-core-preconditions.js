import fs from 'fs';
import crypto from 'crypto';
import { execFile } from 'child_process';
import { promisify } from 'util';
import { logger } from '../utils/logger.js';

const execFileAsync = promisify(execFile);
const SEEDED_SESSION_TOKENS = new Set();
const SEEDED_MERCHANT_USERS = new Set();
const UNENCRYPTED_SESSION_METADATA_BASE64 = 'eyJlbmNyeXB0aW9uRmxvdyI6Ik5PTkUifQ==';
const EMPTY_MERCHANT_SHARED_DATA_BASE64 = Buffer.from(
  JSON.stringify({
    organizationDetails: {},
    userData: {},
    businessDetails: {},
    vintageData: {}
  })
).toString('base64');

function sqlEscape(value) {
  return String(value ?? '').replaceAll("'", "''");
}

function buildLspStyleId() {
  return `LSP${crypto.randomUUID().replaceAll('-', '')}`;
}

function getPsqlBinary() {
  const explicitPath = process.env.ART_PSQL_BIN;
  if (explicitPath && fs.existsSync(explicitPath)) {
    return explicitPath;
  }

  const storeRoot = '/nix/store';
  try {
    const candidates = fs.readdirSync(storeRoot)
      .filter(name => name.includes('postgresql-'))
      .map(name => `${storeRoot}/${name}/bin/psql`)
      .filter(candidate => fs.existsSync(candidate))
      .sort();

    return candidates[0] || null;
  } catch {
    return null;
  }
}

async function seedLoanStatusSession(sessionToken, userId, entry) {
  const psqlBinary = getPsqlBinary();
  if (!psqlBinary) {
    logger.warn('Unable to seed LSP session: psql binary not found', {
      logTag: entry?.logTag,
      sessionToken
    });
    return;
  }

  const now = new Date();
  const expiry = new Date(now.getTime() + 24 * 60 * 60 * 1000);
  const requestId = entry?.requestId || buildLspStyleId();
  const merchantId = entry?.message?.merchant_id || 'flipkart';
  const orderId = entry?.message?.order_id || entry?.orderId || '';

  const sql = `
    INSERT INTO public.session (
      id,
      request_id,
      merchant_user_id,
      session_token,
      status,
      expiry,
      created_at,
      updated_at,
      order_id,
      merchant_user_profile_id,
      txn_intent_id,
      merchant_id,
      metadata
    ) VALUES (
      '${sqlEscape(buildLspStyleId())}',
      '${sqlEscape(requestId)}',
      '${sqlEscape(userId)}',
      '${sqlEscape(sessionToken)}',
      'ACTIVE',
      '${expiry.toISOString()}',
      '${now.toISOString()}',
      '${now.toISOString()}',
      ${orderId ? `'${sqlEscape(orderId)}'` : 'NULL'},
      '',
      NULL,
      '${sqlEscape(merchantId)}',
      '${UNENCRYPTED_SESSION_METADATA_BASE64}'
    )
    ON CONFLICT (session_token) DO NOTHING;
  `;

  const env = {
    ...process.env,
    PGHOST: process.env.ART_LSP_DB_SOCKET_DIR || '/home/kumar-aman/Desktop/repos2/euler-lsp/data/lsp-db',
    PGUSER: process.env.ART_LSP_DB_USER || 'testUser',
    PGPASSWORD: process.env.ART_LSP_DB_PASSWORD || 'testPassword',
    PGDATABASE: process.env.ART_LSP_DB_NAME || 'testLsp'
  };

  await execFileAsync(psqlBinary, ['-v', 'ON_ERROR_STOP=1', '-c', sql], { env });

  logger.info('Seeded LSP session for loan status replay', {
    logTag: entry?.logTag,
    sessionToken,
    userId,
    orderId
  });
}

async function seedLoanStatusMerchantUser(userId, entry) {
  const psqlBinary = getPsqlBinary();
  if (!psqlBinary) {
    logger.warn('Unable to seed LSP merchant_user: psql binary not found', {
      logTag: entry?.logTag,
      userId
    });
    return;
  }

  const now = new Date();
  const merchantId = entry?.message?.merchant_id || 'flipkart';
  const merchantCustomerId =
    entry?.message?.merchantCustomerId ||
    entry?.message?.customerId ||
    entry?.message?.customer_id ||
    userId;
  const appRefId = buildLspStyleId();
  const sql = `
    INSERT INTO public.merchant_user (
      id,
      merchant_id,
      status,
      created_at,
      updated_at,
      app_ref_id,
      primary_pii_refid,
      primary_pii_type,
      merchant_customer_id,
      merchant_shared_data_enc,
      metadata
    ) VALUES (
      '${sqlEscape(userId)}',
      '${sqlEscape(merchantId)}',
      'ACTIVE',
      '${now.toISOString()}',
      '${now.toISOString()}',
      '${sqlEscape(appRefId)}',
      '${sqlEscape(merchantCustomerId)}',
      'CUSTOMER',
      '${sqlEscape(merchantCustomerId)}',
      'DataRealm :: ${sqlEscape(EMPTY_MERCHANT_SHARED_DATA_BASE64)}',
      '{}'::json
    )
    ON CONFLICT (id) DO UPDATE SET
      merchant_id = EXCLUDED.merchant_id,
      status = EXCLUDED.status,
      updated_at = EXCLUDED.updated_at,
      app_ref_id = EXCLUDED.app_ref_id,
      primary_pii_refid = EXCLUDED.primary_pii_refid,
      primary_pii_type = EXCLUDED.primary_pii_type,
      merchant_customer_id = EXCLUDED.merchant_customer_id,
      merchant_shared_data_enc = EXCLUDED.merchant_shared_data_enc,
      metadata = EXCLUDED.metadata;
  `;

  const env = {
    ...process.env,
    PGHOST: process.env.ART_LSP_DB_SOCKET_DIR || '/home/kumar-aman/Desktop/repos2/euler-lsp/data/lsp-db',
    PGUSER: process.env.ART_LSP_DB_USER || 'testUser',
    PGPASSWORD: process.env.ART_LSP_DB_PASSWORD || 'testPassword',
    PGDATABASE: process.env.ART_LSP_DB_NAME || 'testLsp'
  };

  await execFileAsync(psqlBinary, ['-v', 'ON_ERROR_STOP=1', '-c', sql], { env });

  logger.info('Seeded LSP merchant_user for loan status replay', {
    logTag: entry?.logTag,
    userId,
    merchantId,
    merchantCustomerId
  });
}

export async function ensureAppCorePreconditions(entry, customHeaders = {}) {
  if (!entry || entry.sourceDestination !== 'APP_CORE') {
    return;
  }

  if (entry.logTag !== 'LSP-LoanStatus_REQUEST') {
    return;
  }

  const sessionToken = customHeaders['x-session-token'];
  const userId = customHeaders['x-user-id'];

  if (!sessionToken || !userId) {
    logger.warn('Skipping LSP session seeding due to missing auth headers', {
      logTag: entry.logTag,
      hasSessionToken: Boolean(sessionToken),
      hasUserId: Boolean(userId)
    });
    return;
  }

  if (SEEDED_SESSION_TOKENS.has(sessionToken) && SEEDED_MERCHANT_USERS.has(userId)) {
    return;
  }

  try {
    if (!SEEDED_MERCHANT_USERS.has(userId)) {
      await seedLoanStatusMerchantUser(userId, entry);
      SEEDED_MERCHANT_USERS.add(userId);
    }

    if (!SEEDED_SESSION_TOKENS.has(sessionToken)) {
      await seedLoanStatusSession(sessionToken, userId, entry);
      SEEDED_SESSION_TOKENS.add(sessionToken);
    }
  } catch (error) {
    logger.warn('Failed to seed LSP auth preconditions for loan status replay', {
      logTag: entry.logTag,
      sessionToken,
      userId,
      error: error.message
    });
  }
}
