import { logger } from '../utils/logger.js';

export class SseManager {
  constructor() {
    this.clients = new Set();
  }

  addClient(id, res) {
    this.clients.add({ id, res });
  }

  removeClient(id) {
    for (const client of this.clients) {
      if (client.id === id) {
        this.clients.delete(client);
        break;
      }
    }
  }

  broadcastRaw(level, message) {
    const logData = { level, message, timestamp: new Date().toISOString() };
    for (const client of this.clients) {
      try {
        client.res.write(`data: ${JSON.stringify(logData)}\n\n`);
      } catch (_) {
        this.clients.delete(client);
      }
    }
  }

  broadcast(level, message) {
    this.broadcastRaw(level, message);
    (logger[level.toLowerCase()] ?? logger.info).call(logger, message);
  }

  broadcastReportReady() {
    const payload = JSON.stringify({
      level: 'INFO',
      message: 'Report ready',
      timestamp: new Date().toISOString(),
      reportUpdate: true
    });
    for (const client of this.clients) {
      try {
        client.res.write(`data: ${payload}\n\n`);
      } catch (_) {
        this.clients.delete(client);
      }
    }
  }

  closeAll() {
    for (const client of this.clients) {
      try { client.res.end(); } catch (_) {}
    }
    this.clients.clear();
  }
}
