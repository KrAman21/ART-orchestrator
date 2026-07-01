import { logger } from '../utils/logger.js';

function decodeOrderJson(orderJson) {
  if (!orderJson || typeof orderJson !== 'string') {
    return null;
  }

  try {
    return JSON.parse(Buffer.from(orderJson, 'base64').toString('utf8'));
  } catch (error) {
    logger.debug('Failed to decode orderJson while extracting ART routing identifiers', {
      error: error.message
    });
    return null;
  }
}

export function extractRoutingIdentifiers(requestPayload, requestHeaders = {}) {
  const decodedOrderJson = decodeOrderJson(requestPayload?.orderJson);
  const loanApplicationId =
    requestPayload?.loan_application_id ||
    requestPayload?.loanApplicationId ||
    requestPayload?.loanApplication?.loanApplicationId ||
    requestPayload?.loanApplication?.loan_application_id ||
    requestPayload?.softEligibility?.loanApplicationId ||
    requestPayload?.softEligibility?.loan_application_id ||
    requestPayload?.themisDetail?.loanApplicationId ||
    requestHeaders['x-loan-application-id'];

  const orderId =
    requestPayload?.order_id ||
    requestPayload?.orderId ||
    requestPayload?.checkoutData?.orderDetails?.orderId ||
    requestPayload?.checkoutData?.orderDetails?.order_id ||
    requestPayload?.loanApplication?.checkoutData?.orderDetails?.orderId ||
    requestPayload?.loanApplication?.checkoutData?.orderDetails?.order_id ||
    requestPayload?.softEligibility?.orderId ||
    requestPayload?.softEligibility?.order_id ||
    decodedOrderJson?.order_id ||
    decodedOrderJson?.orderId ||
    requestHeaders['x-order-id'];

  return { loanApplicationId, orderId };
}

class SessionOrchestratorRegistry {
  constructor() {
    this.sessions = new Map();
  }

  register(sessionId, orchestrator, orderIds = []) {
    this.sessions.set(sessionId, {
      sessionId,
      orchestrator,
      orderIds: new Set(orderIds),
      loanApplicationIds: new Set(),
      registeredAt: Date.now()
    });
    logger.info('Registered orchestrator for session', { sessionId, orderCount: orderIds.length });
  }

  unregister(sessionId) {
    this.sessions.delete(sessionId);
    logger.info('Unregistered orchestrator for session', { sessionId });
  }

  findByLoanApplicationId(loanApplicationId) {
    for (const [, entry] of this.sessions) {
      if (entry.loanApplicationIds.has(loanApplicationId)) {
        return entry.orchestrator;
      }
    }
    return null;
  }

  findByOrderId(orderId) {
    for (const [, entry] of this.sessions) {
      if (entry.orderIds.has(orderId)) {
        return entry.orchestrator;
      }
    }
    return null;
  }

  findFirstActive() {
    const activeEntries = [];
    for (const [, entry] of this.sessions) {
      if (entry.orchestrator.isRunning) {
        activeEntries.push(entry);
      }
    }

    if (activeEntries.length === 1) {
      return activeEntries[0].orchestrator;
    }

    if (activeEntries.length > 1) {
      logger.warn('Multiple active orchestrators present; refusing ambiguous fallback routing', {
        activeSessions: activeEntries.map(entry => ({
          sessionId: entry.sessionId,
          orderCount: entry.orderIds.size,
          loanApplicationCount: entry.loanApplicationIds.size
        }))
      });
    }

    return null;
  }

  findOrchestrator(requestPayload, requestHeaders = {}) {
    const session = this.findSessionForRequest(requestPayload, requestHeaders);
    return session?.orchestrator || null;
  }

  findSessionForRequest(requestPayload, requestHeaders = {}) {
    const { loanApplicationId, orderId } = extractRoutingIdentifiers(requestPayload, requestHeaders);
    if (loanApplicationId) {
      for (const [, entry] of this.sessions) {
        if (entry.loanApplicationIds.has(loanApplicationId)) {
          return entry;
        }
      }
    }

    if (orderId) {
      for (const [, entry] of this.sessions) {
        if (entry.orderIds.has(orderId)) {
          return entry;
        }
      }
    }

    const fallbackOrchestrator = this.findFirstActive();
    if (!fallbackOrchestrator) {
      return null;
    }

    for (const [, entry] of this.sessions) {
      if (entry.orchestrator === fallbackOrchestrator) {
        return entry;
      }
    }

    return null;
  }

  addLoanApplicationId(sessionId, loanApplicationId) {
    const entry = this.sessions.get(sessionId);
    if (entry && loanApplicationId) {
      entry.loanApplicationIds.add(loanApplicationId);
    }
  }

  getSession(sessionId) {
    return this.sessions.get(sessionId) || null;
  }

  getActiveCount() {
    let count = 0;
    for (const [, entry] of this.sessions) {
      if (entry.orchestrator.isRunning) count++;
    }
    return count;
  }

  getAllSessions() {
    return Array.from(this.sessions.values()).map(entry => ({
      sessionId: entry.sessionId,
      isRunning: entry.orchestrator.isRunning,
      orderCount: entry.orderIds.size,
      loanApplicationCount: entry.loanApplicationIds.size,
      registeredAt: entry.registeredAt
    }));
  }
}

export default SessionOrchestratorRegistry;
