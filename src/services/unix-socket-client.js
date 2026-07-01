import http from 'http';
import https from 'https';
import { logger } from '../utils/logger.js';

export function createUnixSocketAgent(socketPath) {
  return function createConnection(hostname, port, options, callback) {
    const socket = new (require('net').Socket)();
    socket.connect(socketPath, function() {
      callback();
    });
    return {
      socket,
      secureContext: options.secureContext,
      rejectUnauthorized: options.rejectUnauthorized
    };
  };
}

export async function unixSocketRequest(socketPath, baseUrl, endpoint, options = {}) {
  const { method = 'GET', body, headers = {}, timeout = 30000 } = options;
  const startedAt = Date.now();
  
  let url;
  if (baseUrl.startsWith('http')) {
    url = `${baseUrl}${endpoint}`;
  } else {
    url = `http://localhost${endpoint}`;
  }

  const parsed = new URL(url);
  const isHttps = parsed.protocol === 'https:';
  const client = isHttps ? https : http;
  
  const path = `${parsed.pathname}${parsed.search || ''}`;
  const hostPort = parsed.host.split(':');
  const host = hostPort[0];
  const port = hostPort[1] || (isHttps ? 443 : 80);

  return new Promise((resolve, reject) => {
    const reqOptions = {
      socketPath,
      path,
      method,
      hostname: host,
      port,
      headers: {
        'Host': `${host}:${port}`,
        'Content-Type': 'application/json',
        'Accept': 'application/json',
        ...headers
      }
    };

    const requestId = headers['x-request-id'] || headers['X-Request-Id'] || null;
    logger.info('ART_SOCKET_TRACE_REQUEST_START', {
      socketPath,
      method,
      path,
      requestId,
      bodyBytes: body ? Buffer.byteLength(String(body)) : 0,
      timeout
    });

    const req = client.request(reqOptions, (res) => {
      const chunks = [];
      res.on('data', chunk => chunks.push(chunk));
      res.on('end', () => {
        const body = chunks.join('');
        let data;
        try {
          data = JSON.parse(body);
        } catch {
          data = body;
        }
        logger.info('ART_SOCKET_TRACE_RESPONSE_END', {
          socketPath,
          method,
          path,
          requestId,
          status: res.statusCode,
          statusText: res.statusMessage,
          durationMs: Date.now() - startedAt,
          chunkCount: chunks.length,
          bodyBytes: Buffer.byteLength(body)
        });
        resolve({
          ok: res.statusCode >= 200 && res.statusCode < 300,
          status: res.statusCode,
          statusText: res.statusMessage,
          data,
          headers: res.headers
        });
      });

      res.on('aborted', () => {
        logger.warn('ART_SOCKET_TRACE_RESPONSE_ABORTED', {
          socketPath,
          method,
          path,
          requestId,
          status: res.statusCode,
          durationMs: Date.now() - startedAt,
          chunkCount: chunks.length
        });
      });
    });

    req.on('error', (err) => {
      logger.error('ART_SOCKET_TRACE_REQUEST_ERROR', {
        socketPath,
        method,
        path,
        requestId,
        durationMs: Date.now() - startedAt,
        error: err.message,
        code: err.code
      });
      reject({
        error: true,
        message: err.message,
        code: err.code
      });
    });

    req.on('timeout', () => {
      logger.error('ART_SOCKET_TRACE_REQUEST_TIMEOUT', {
        socketPath,
        method,
        path,
        requestId,
        durationMs: Date.now() - startedAt,
        timeout
      });
      req.destroy();
      reject({
        error: true,
        message: 'Request timeout',
        code: 'ETIMEDOUT'
      });
    });

    req.setTimeout(timeout);

    if (body) {
      req.write(body);
    }
    req.end();
  });
}

export function createFetchSocketAgent(socketPath) {
  return {
    dispatch: (url, options) => {
      return new Promise((resolve, reject) => {
        const parsed = new URL(url);
        const isHttps = parsed.protocol === 'https:';
        const client = isHttps ? https : http;
        const path = `${parsed.pathname}${parsed.search || ''}`;

        const req = client.request({
          socketPath,
          path,
          method: options.method || 'GET',
          hostname: parsed.hostname,
          port: parsed.port || (isHttps ? 443 : 80),
          headers: {
            'Host': parsed.host,
            ...options.headers
          }
        }, (res) => {
          const chunks = [];
          res.on('data', chunk => chunks.push(chunk));
          res.on('end', () => {
            const body = chunks.join('');
            resolve(new Response(body, {
              status: res.statusCode,
              statusText: res.statusMessage,
              headers: res.headers
            }));
          });
        });

        req.on('error', reject);
        if (options.body) req.write(options.body);
        req.end();
      });
    }
  };
}
