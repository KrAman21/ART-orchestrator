const LOCAL_LOAN_STATUS_OVERRIDES = {
  flipkart: {
    userId: 'LSP189a9489d04244afbdfb8f0ecdc654d6',
    sessionToken: 'LSPf0fecc092c2b4bd4a04c28870e3d5da3'
  }
};

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

  const localOverride = LOCAL_LOAN_STATUS_OVERRIDES[merchantId];
  const sessionToken = localOverride?.sessionToken || matchingResponse?.payload?.sessionToken;
  const userId = localOverride?.userId || matchingResponse?.payload?.userId;

  return {
    ...(merchantId ? { 'x-merchant-id': merchantId } : {}),
    ...(sessionToken ? { 'x-session-token': sessionToken } : {}),
    ...(userId ? { 'x-user-id': userId } : {})
  };
}
