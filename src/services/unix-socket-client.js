import http from 'http';
import https from 'https';

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
        resolve({
          ok: res.statusCode >= 200 && res.statusCode < 300,
          status: res.statusCode,
          statusText: res.statusMessage,
          data,
          headers: res.headers
        });
      });
    });

    req.on('error', (err) => {
      reject({
        error: true,
        message: err.message,
        code: err.code
      });
    });

    req.on('timeout', () => {
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