function findReplayLoanStatusAuth(candidate) {
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
      payload.data?.user_id
  };
}

export function buildAppCoreAuthHeaders(entry, entries = []) {
  if (!entry || entry.sourceDestination !== 'APP_CORE') {
    return {};
  }

  if (entry.logTag !== 'LSP-LoanStatus_REQUEST') {
    return {};
  }

  const merchantId = entry.message?.merchant_id;
  const loanApplicationId =
    entry.loanApplicationId ||
    entry.payload?.loanApplicationId ||
    entry.payload?.loan_application_id;

  if (!loanApplicationId) {
    return merchantId ? { 'x-merchant-id': merchantId } : {};
  }

  const matchingResponse = [...entries]
    .slice(0, entry.index)
    .reverse()
    .find(candidate =>
      candidate?.logTag === 'GetLenderFlows_RESPONSE' &&
      candidate.loanApplicationId === loanApplicationId &&
      candidate.payload
    );

  const replayAuth = findReplayLoanStatusAuth(matchingResponse);
  const sessionToken = replayAuth.sessionToken || process.env.LOAN_STATUS_SESSION_TOKEN;
  const userId = replayAuth.userId || process.env.LOAN_STATUS_USER_ID;

  return {
    ...(merchantId ? { 'x-merchant-id': merchantId } : {}),
    ...(sessionToken ? { 'x-session-token': sessionToken } : {}),
    ...(userId ? { 'x-user-id': userId } : {})
  };
}
