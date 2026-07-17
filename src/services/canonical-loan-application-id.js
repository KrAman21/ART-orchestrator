function isPlainObject(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function isHdbWebhookLikePayload(payload) {
  if (!isPlainObject(payload)) {
    return false;
  }

  return (
    typeof payload.partnerRefNo === 'string' ||
    typeof payload.applicationId === 'string'
  );
}

function normalizeJourneySteps(steps, canonicalLoanApplicationId) {
  if (!Array.isArray(steps)) {
    return steps;
  }

  return steps.map(step => {
    if (!isPlainObject(step)) {
      return step;
    }

    return {
      ...step,
      ...(typeof step.loanApplicationId === 'string'
        ? { loanApplicationId: canonicalLoanApplicationId }
        : {}),
      ...(typeof step.loan_application_id === 'string'
        ? { loan_application_id: canonicalLoanApplicationId }
        : {})
    };
  });
}

export function normalizeCanonicalLoanApplicationReferences(payload, canonicalLoanApplicationId) {
  if (!canonicalLoanApplicationId) {
    return payload;
  }

  if (Array.isArray(payload)) {
    return payload.map(item =>
      normalizeCanonicalLoanApplicationReferences(item, canonicalLoanApplicationId)
    );
  }

  if (!isPlainObject(payload)) {
    return payload;
  }

  const normalized = {};

  for (const [key, value] of Object.entries(payload)) {
    if (key === 'referenceId' && typeof value === 'string') {
      normalized[key] = canonicalLoanApplicationId;
      continue;
    }

    if (key === 'partnerRefNo' && typeof value === 'string') {
      normalized[key] = canonicalLoanApplicationId;
      continue;
    }

    if (
      key === 'applicationId' &&
      typeof value === 'string' &&
      isHdbWebhookLikePayload(payload)
    ) {
      normalized[key] = canonicalLoanApplicationId;
      continue;
    }

    if (
      (key === 'loanApplicationId' || key === 'loan_application_id') &&
      typeof value === 'string' &&
      Object.prototype.hasOwnProperty.call(payload, 'state')
    ) {
      normalized[key] = canonicalLoanApplicationId;
      continue;
    }

    if (key === 'journeyData' && isPlainObject(value)) {
      normalized[key] = {
        ...normalizeCanonicalLoanApplicationReferences(value, canonicalLoanApplicationId),
        steps: normalizeJourneySteps(value.steps, canonicalLoanApplicationId)
      };
      continue;
    }

    normalized[key] = normalizeCanonicalLoanApplicationReferences(value, canonicalLoanApplicationId);
  }

  return normalized;
}
