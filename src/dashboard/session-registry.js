import { logger } from '../utils/logger.js';

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
    for (const [, entry] of this.sessions) {
      if (entry.orchestrator.isRunning) {
        return entry.orchestrator;
      }
    }
    return null;
  }

  findOrchestrator(requestPayload, requestHeaders = {}) {
    const loanApplicationId = requestPayload?.loan_application_id ||
      requestPayload?.loanApplicationId ||
      requestHeaders['x-loan-application-id'];
    if (loanApplicationId) {
      const orchestrator = this.findByLoanApplicationId(loanApplicationId);
      if (orchestrator) return orchestrator;
    }

    const orderId = requestPayload?.order_id ||
      requestPayload?.orderId ||
      requestHeaders['x-order-id'];
    if (orderId) {
      const orchestrator = this.findByOrderId(orderId);
      if (orchestrator) return orchestrator;
    }

    return this.findFirstActive();
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
