import fs from 'fs';
import crypto from 'crypto';
import { execFile } from 'child_process';
import { promisify } from 'util';
import { logger } from '../utils/logger.js';
import { SERVICE_MAP } from '../config.js';

const execFileAsync = promisify(execFile);
const SEEDED_SESSION_TOKENS = new Set();
const SEEDED_MERCHANT_USERS = new Set();
const SEEDED_CLIENT_AUTH_TOKENS = new Set();
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

function isDedicatedBackingServicesEnabled() {
  const rawValue = process.env.EULER_ART_DEDICATED_BACKING_SERVICES;
  if (typeof rawValue !== 'string') {
    return false;
  }

  return ['1', 'true', 'yes', 'on'].includes(rawValue.trim().toLowerCase());
}

function getLspDbSocketDir() {
  if (process.env.ART_LSP_DB_SOCKET_DIR) {
    return process.env.ART_LSP_DB_SOCKET_DIR;
  }

  const lspUnixSocket = SERVICE_MAP?.LSP?.unixSocket;
  if (lspUnixSocket) {
    if (lspUnixSocket.endsWith('/data/el/el.sock')) {
      return lspUnixSocket.replace(/\/data\/el\/el\.sock$/, '/data/lsp-db');
    }

    const podSocketMatch = lspUnixSocket.match(/^(.*)\/data\/lsp-pods\/pod-(\d+)\/lsp\.sock$/);
    if (podSocketMatch) {
      const [, repoRoot, podNumber] = podSocketMatch;

      if (isDedicatedBackingServicesEnabled()) {
        const dedicatedDbDir = `${repoRoot}/data/lsp-db-pod-${podNumber}`;
        if (fs.existsSync(dedicatedDbDir)) {
          return dedicatedDbDir;
        }
      }

      return `${repoRoot}/data/lsp-db`;
    }

    return lspUnixSocket.replace(/\/euler-lsp\/euler-lsp\.sock$/, '/lsp-db');
  }

  return '/home/kumar-aman/Desktop/repos/euler-lsp/data/lsp-db';
}

function buildPsqlEnv() {
  return {
    ...process.env,
    PGHOST: getLspDbSocketDir(),
    PGUSER: process.env.ART_LSP_DB_USER || 'testUser',
    PGPASSWORD: process.env.ART_LSP_DB_PASSWORD || 'testPassword',
    PGDATABASE: process.env.ART_LSP_DB_NAME || 'testLsp'
  };
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

function extractJsonFromRealmString(value) {
  if (typeof value !== 'string') {
    return null;
  }

  const marker = '::';
  const markerIndex = value.indexOf(marker);
  const candidate = markerIndex >= 0 ? value.slice(markerIndex + marker.length).trim() : value.trim();
  if (!candidate) {
    return null;
  }

  try {
    return JSON.parse(candidate);
  } catch {
    return null;
  }
}

function collectActionRequiredCandidates(payload) {
  if (!payload || typeof payload !== 'object') {
    return [];
  }

  const candidates = [];
  const individualActionId = payload?.kyc?.individualKYC?.actionId;
  if (individualActionId) {
    candidates.push({
      id: individualActionId,
      action: payload?.kyc?.individualKYC?.actionsRequired?.[0]?.action || null,
      actionType: payload?.kyc?.individualKYC?.actionsRequired?.[0]?.actionType || null,
      parentAction: payload?.kyc?.individualKYC?.actionsRequired?.[0]?.parentAction || null
    });
  }

  for (const item of payload?.kyc?.individualKYC?.actionsRequired || []) {
    candidates.push({
      id: item?.id || null,
      action: item?.action || null,
      actionType: item?.actionType || null,
      parentAction: item?.parentAction || null
    });
  }

  for (const item of payload?.kyc?.actionsRequired || []) {
    candidates.push({
      id: item?.id || null,
      action: item?.action || null,
      actionType: item?.actionType || null,
      parentAction: item?.parentAction || null
    });
  }

  return candidates.filter(candidate => candidate.id);
}

function findMappedActionRequiredId(appResponse, replayCandidates) {
  const liveActions = [
    ...(appResponse?.kyc?.individualKYC?.actionsRequired || []),
    ...(appResponse?.kyc?.actionsRequired || [])
  ].filter(action => action?.id);

  if (liveActions.length === 0 || replayCandidates.length === 0) {
    return null;
  }

  for (const replayCandidate of replayCandidates) {
    const exactMatch = liveActions.find(liveAction =>
      liveAction.action === replayCandidate.action &&
      liveAction.actionType === replayCandidate.actionType &&
      liveAction.parentAction === replayCandidate.parentAction
    );
    if (exactMatch?.id) {
      return {
        originalActionId: replayCandidate.id,
        liveActionId: exactMatch.id
      };
    }
  }

  if (liveActions[0]?.id && replayCandidates[0]?.id) {
    return {
      originalActionId: replayCandidates[0].id,
      liveActionId: liveActions[0].id
    };
  }

  return null;
}

async function syncUpdateKycActionRequiredMapping(entry, stateManager) {
  if (!stateManager || entry?.logTag !== 'UpdateKYCRequest_REQUEST') {
    return;
  }

  const replayCandidates = collectActionRequiredCandidates(entry?.payload);
  if (replayCandidates.length === 0) {
    logger.info('Skipping UpdateKYC actionRequired mapping sync: no replay action ids found', {
      logTag: entry?.logTag
    });
    return;
  }

  const mappedLoanApplicationId = stateManager.getMappedIdentifier(
    'loanApplicationId',
    entry.loanApplicationId || entry?.payload?.loanApplicationId
  );
  if (!mappedLoanApplicationId) {
    logger.info('Skipping UpdateKYC actionRequired mapping sync: no mapped loanApplicationId', {
      logTag: entry?.logTag
    });
    return;
  }

  const psqlBinary = getPsqlBinary();
  if (!psqlBinary) {
    logger.warn('Unable to sync UpdateKYC actionRequired mapping: psql binary not found', {
      logTag: entry?.logTag
    });
    return;
  }

  const sql = `
    SELECT app_response_enc
    FROM public.first_stage_request_data
    WHERE loan_app_id = '${sqlEscape(mappedLoanApplicationId)}'
      AND api_name = 'TriggerKYC'
    ORDER BY created_at DESC
    LIMIT 1;
  `;

  try {
    const { stdout } = await execFileAsync(
      psqlBinary,
      ['-v', 'ON_ERROR_STOP=1', '-t', '-A', '-c', sql],
      { env: buildPsqlEnv() }
    );

    const appResponse = extractJsonFromRealmString(stdout.trim());
    const mappedAction = findMappedActionRequiredId(appResponse, replayCandidates);

    if (!mappedAction?.originalActionId || !mappedAction?.liveActionId) {
      logger.warn('UpdateKYC actionRequired mapping sync could not find live action id', {
        logTag: entry?.logTag,
        mappedLoanApplicationId,
        replayActionIds: replayCandidates.map(candidate => candidate.id)
      });
      return;
    }

    stateManager.registerIdentifierMapping(
      'actionRequiredId',
      mappedAction.originalActionId,
      mappedAction.liveActionId
    );

    logger.info('Synced UpdateKYC actionRequired replay mapping', {
      logTag: entry?.logTag,
      mappedLoanApplicationId,
      originalActionId: mappedAction.originalActionId,
      liveActionId: mappedAction.liveActionId
    });
  } catch (error) {
    logger.warn('Failed to sync UpdateKYC actionRequired mapping', {
      logTag: entry?.logTag,
      mappedLoanApplicationId,
      error: error.message
    });
  }
}

async function seedLoanStatusSession(sessionToken, userId, deviceTokenId, entry) {
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
  const sessionId = deviceTokenId || buildLspStyleId();

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
      device_token_id,
      merchant_id,
      metadata
    ) VALUES (
      '${sqlEscape(sessionId)}',
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
      ${deviceTokenId ? `'${sqlEscape(deviceTokenId)}'` : 'NULL'},
      '${sqlEscape(merchantId)}',
      '${UNENCRYPTED_SESSION_METADATA_BASE64}'
    )
    ON CONFLICT (session_token) DO NOTHING;
  `;

  await execFileAsync(psqlBinary, ['-v', 'ON_ERROR_STOP=1', '-c', sql], { env: buildPsqlEnv() });

  logger.info('Seeded LSP session for loan status replay', {
    logTag: entry?.logTag,
    sessionToken,
    userId,
    orderId,
    sessionId,
    deviceTokenId
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

  await execFileAsync(psqlBinary, ['-v', 'ON_ERROR_STOP=1', '-c', sql], { env: buildPsqlEnv() });

  logger.info('Seeded LSP merchant_user for loan status replay', {
    logTag: entry?.logTag,
    userId,
    merchantId,
    merchantCustomerId
  });
}

async function seedClientAuthTokenForGetLenderFlows(entry) {
  const psqlBinary = getPsqlBinary();
  if (!psqlBinary) {
    logger.warn('Unable to seed CAT for getLenderFlows: psql binary not found', {
      logTag: entry?.logTag
    });
    return;
  }

  const payload = entry?.payload || {};
  const clientAuthToken = payload.clientAuthToken;
  const customerId = payload.customerId;
  const merchantId = entry?.message?.merchant_id || payload.merchantId || payload.merchant_id || 'flipkart';

  if (!clientAuthToken || !customerId) {
    logger.warn('Skipping CAT seeding due to missing getLenderFlows token/customer', {
      logTag: entry?.logTag,
      hasClientAuthToken: Boolean(clientAuthToken),
      hasCustomerId: Boolean(customerId)
    });
    return;
  }

  if (SEEDED_CLIENT_AUTH_TOKENS.has(clientAuthToken)) {
    return;
  }

  const now = new Date();
  const expiry = new Date(now.getTime() + 24 * 60 * 60 * 1000);
  const sql = `
    INSERT INTO public.cat (
      id,
      merchant_id,
      customer_id,
      auth_token,
      status,
      expiry,
      created_at,
      updated_at
    ) VALUES (
      '${sqlEscape(buildLspStyleId())}',
      '${sqlEscape(merchantId)}',
      '${sqlEscape(customerId)}',
      '${sqlEscape(clientAuthToken)}',
      'ACTIVE',
      '${expiry.toISOString()}',
      '${now.toISOString()}',
      '${now.toISOString()}'
    )
    ON CONFLICT (auth_token) DO UPDATE SET
      merchant_id = EXCLUDED.merchant_id,
      customer_id = EXCLUDED.customer_id,
      status = 'ACTIVE',
      expiry = EXCLUDED.expiry,
      updated_at = EXCLUDED.updated_at;
  `;

  await execFileAsync(psqlBinary, ['-v', 'ON_ERROR_STOP=1', '-c', sql], { env: buildPsqlEnv() });
  SEEDED_CLIENT_AUTH_TOKENS.add(clientAuthToken);

  logger.info('Seeded CAT for getLenderFlows replay', {
    logTag: entry?.logTag,
    merchantId,
    customerId,
    dbSocketDir: getLspDbSocketDir()
  });
}

export async function ensureAppCorePreconditions(entry, customHeaders = {}, stateManager = null) {
  if (!entry || entry.sourceDestination !== 'APP_CORE') {
    return;
  }

  if (entry.logTag === 'GetLenderFlows_REQUEST') {
    try {
      await seedClientAuthTokenForGetLenderFlows(entry);
    } catch (error) {
      logger.warn('Failed to seed CAT for getLenderFlows replay', {
        logTag: entry.logTag,
        error: error.message
      });
    }
    return;
  }

  const sessionToken = customHeaders['x-session-token'];
  const userId = customHeaders['x-user-id'];
  const deviceTokenId = customHeaders['x-device-token-id'];

  await syncUpdateKycActionRequiredMapping(entry, stateManager);

  if (!sessionToken || !userId) {
    logger.info('Skipping APP_CORE session seeding due to missing auth headers', {
      logTag: entry.logTag,
      hasSessionToken: Boolean(sessionToken),
      hasUserId: Boolean(userId),
      hasDeviceTokenId: Boolean(deviceTokenId)
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
      await seedLoanStatusSession(sessionToken, userId, deviceTokenId, entry);
      SEEDED_SESSION_TOKENS.add(sessionToken);
    }
  } catch (error) {
    logger.warn('Failed to seed APP_CORE auth preconditions for replay', {
      logTag: entry.logTag,
      sessionToken,
      userId,
      deviceTokenId,
      error: error.message
    });
  }
}
