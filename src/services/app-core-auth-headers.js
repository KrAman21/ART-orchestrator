import { logger } from '../utils/logger.js';

function maskValue(value) {
  if (!value || typeof value !== 'string') {
    return null;
  }

  if (value.length <= 8) {
    return value;
  }

  return `${value.slice(0, 4)}...${value.slice(-4)}`;
}

const DEFAULT_X_FORWARDED_FOR = '127.0.0.1';

function findReplayAppCoreAuth(candidate) {
  if (!candidate || typeof candidate !== 'object') {
    return {};
  }

  const payload = candidate.payload && typeof candidate.payload === 'object'
    ? candidate.payload
    : {};

  return {
    sessionToken:
      payload.sessionToken ||
      payload.session_token ||
      payload.data?.sessionToken ||
      payload.data?.session_token,
    userId:
      payload.userId ||
      payload.user_id ||
      payload.data?.userId ||
      payload.data?.user_id,
    deviceTokenId:
      payload.deviceTokenId ||
      payload.device_token_id ||
      payload.data?.deviceTokenId ||
      payload.data?.device_token_id
  };
}

function findMatchingGetLenderFlowsResponse(entry, entries = []) {
  if (!entry) {
    return null;
  }

  const loanApplicationId =
    entry.loanApplicationId ||
    entry.payload?.loanApplicationId ||
    entry.payload?.loan_application_id;

  if (!loanApplicationId) {
    return null;
  }

  return [...entries]
    .slice(0, entry.index)
    .reverse()
    .find(candidate =>
      candidate?.logTag === 'GetLenderFlows_RESPONSE' &&
      candidate.loanApplicationId === loanApplicationId &&
      candidate.payload
    );
}

export function buildReplaySessionHeaders(entry, entries = [], stateManager = null) {
  const loanApplicationId =
    entry?.loanApplicationId ||
    entry?.payload?.loanApplicationId ||
    entry?.payload?.loan_application_id ||
    null;
  const liveReplayAuth = typeof stateManager?.getReplayAppAuth === 'function'
    ? stateManager.getReplayAppAuth(loanApplicationId)
    : null;
  const currentReplaySessionToken = typeof stateManager?.getCurrentReplaySessionToken === 'function'
    ? stateManager.getCurrentReplaySessionToken()
    : null;
  const matchingResponse = findMatchingGetLenderFlowsResponse(entry, entries);
  const replayAuth = liveReplayAuth || findReplayAppCoreAuth(matchingResponse);
  const sessionToken = replayAuth?.sessionToken || currentReplaySessionToken || process.env.LOAN_STATUS_SESSION_TOKEN;

  if (!sessionToken) {
    return {};
  }

  logger.info('Resolved replay session token from GetLenderFlows context', {
    logTag: entry?.logTag || null,
    loanApplicationId,
    matchedReplayAuthSource: liveReplayAuth
      ? 'LIVE_REPLAY_STATE'
      : currentReplaySessionToken
        ? 'CURRENT_REPLAY_SESSION_TOKEN'
        : matchingResponse?.logTag || null,
    hasSessionToken: true,
    sessionTokenPreview: maskValue(sessionToken)
  });

  return {
    'x-session-token': sessionToken
  };
}

export function buildAppCoreAuthHeaders(entry, entries = [], stateManager = null) {
  if (!entry || entry.sourceDestination !== 'APP_CORE') {
    return {};
  }

  const merchantId =
    entry.message?.merchant_id ||
    entry.payload?.merchantId ||
    entry.payload?.merchant_id;
  const orderId = entry.message?.order_id || entry.orderId;
  const loanApplicationId =
    entry.loanApplicationId ||
    entry.payload?.loanApplicationId ||
    entry.payload?.loan_application_id;
  const baseHeaders = {
    ...(merchantId ? { 'x-merchant-id': merchantId } : {}),
    ...(orderId ? { 'x-order-id': orderId } : {})
  };

  if (!loanApplicationId) {
    logger.info('APP_CORE auth headers resolved without loanApplicationId', {
      logTag: entry.logTag,
      hasMerchantId: Boolean(merchantId),
      hasOrderId: Boolean(orderId)
    });
    return baseHeaders;
  }

  const matchingResponse = findMatchingGetLenderFlowsResponse(entry, entries);
  const liveReplayAuth = typeof stateManager?.getReplayAppAuth === 'function'
    ? stateManager.getReplayAppAuth(loanApplicationId)
    : null;
  const currentReplaySessionToken = typeof stateManager?.getCurrentReplaySessionToken === 'function'
    ? stateManager.getCurrentReplaySessionToken()
    : null;
  const replayAuth = liveReplayAuth || findReplayAppCoreAuth(matchingResponse);
  const sessionToken = replayAuth?.sessionToken || currentReplaySessionToken || process.env.LOAN_STATUS_SESSION_TOKEN;
  const userId = replayAuth?.userId || process.env.LOAN_STATUS_USER_ID;
  const deviceTokenId = replayAuth?.deviceTokenId;
  const forwardedForFromState = typeof stateManager?.resolveForwardedFor === 'function'
    ? stateManager.resolveForwardedFor(entry)
    : null;
  const forwardedFor =
    entry.headers?.['x-forwarded-for'] ||
    entry.headers?.['X-Forwarded-For'] ||
    forwardedForFromState ||
    process.env.ART_X_FORWARDED_FOR ||
    process.env.X_FORWARDED_FOR ||
    DEFAULT_X_FORWARDED_FOR;

  logger.info('APP_CORE auth headers resolved from replay context', {
    logTag: entry.logTag,
    loanApplicationId,
    matchedReplayAuthSource: liveReplayAuth
      ? 'LIVE_REPLAY_STATE'
      : currentReplaySessionToken
        ? 'CURRENT_REPLAY_SESSION_TOKEN'
        : matchingResponse?.logTag || null,
    hasMerchantId: Boolean(merchantId),
    hasOrderId: Boolean(orderId),
    hasSessionToken: Boolean(sessionToken),
    hasUserId: Boolean(userId),
    hasDeviceTokenId: Boolean(deviceTokenId),
    hasForwardedFor: Boolean(forwardedFor),
    forwardedForSource:
      entry.headers?.['x-forwarded-for'] ||
      entry.headers?.['X-Forwarded-For']
        ? 'entry_headers'
        : forwardedForFromState
          ? 'state_manager'
          : process.env.ART_X_FORWARDED_FOR
            ? 'env_ART_X_FORWARDED_FOR'
            : process.env.X_FORWARDED_FOR
              ? 'env_X_FORWARDED_FOR'
              : 'default_loopback',
    sessionTokenPreview: maskValue(sessionToken),
    userIdPreview: maskValue(userId),
    deviceTokenIdPreview: maskValue(deviceTokenId)
  });

  return {
    ...baseHeaders,
    ...(sessionToken ? { 'x-session-token': sessionToken } : {}),
    ...(userId ? { 'x-user-id': userId } : {}),
    ...(deviceTokenId ? { 'x-device-token-id': deviceTokenId } : {}),
    ...(forwardedFor ? { 'x-forwarded-for': forwardedFor } : {})
  };
}
