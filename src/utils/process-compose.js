import http from 'http';

const PROCESS_COMPOSE_SOCKET = process.env.PROCESS_COMPOSE_SOCKET || null;
const PROCESS_COMPOSE_STOP_PATH = process.env.PROCESS_COMPOSE_STOP_PATH || '/project/stop';
const PROCESS_COMPOSE_STOP_ENABLED = process.env.PROCESS_COMPOSE_STOP_ENABLED !== 'false';

let stopInFlight = null;

export async function stopProcessCompose(reason = 'ART lifecycle event') {
  if (!PROCESS_COMPOSE_STOP_ENABLED) {
    console.log(`[process-compose] Stop skipped because it is disabled. Reason: ${reason}`);
    return { skipped: true, reason: 'disabled' };
  }

  if (!PROCESS_COMPOSE_SOCKET) {
    console.log(`[process-compose] Stop skipped because PROCESS_COMPOSE_SOCKET is not set. Reason: ${reason}`);
    return { skipped: true, reason: 'missing_socket' };
  }

  if (stopInFlight) {
    return stopInFlight;
  }

  stopInFlight = new Promise((resolve) => {
    const request = http.request(
      {
        socketPath: PROCESS_COMPOSE_SOCKET,
        path: PROCESS_COMPOSE_STOP_PATH,
        method: 'POST',
        headers: {
          Host: 'localhost'
        }
      },
      (response) => {
        let body = '';
        response.setEncoding('utf8');
        response.on('data', chunk => {
          body += chunk;
        });
        response.on('end', () => {
          console.log(`[process-compose] Stop requested. Reason: ${reason}. Status: ${response.statusCode}. Body: ${body.trim()}`);
          resolve({
            ok: response.statusCode >= 200 && response.statusCode < 300,
            statusCode: response.statusCode,
            body
          });
        });
      }
    );

    request.on('error', (error) => {
      console.error(`[process-compose] Stop request failed for reason "${reason}": ${error.message}`);
      resolve({
        ok: false,
        error: error.message
      });
    });

    request.setTimeout(15000, () => {
      request.destroy(new Error('Timed out while stopping process-compose'));
    });

    request.end();
  }).finally(() => {
    stopInFlight = null;
  });

  return stopInFlight;
}
