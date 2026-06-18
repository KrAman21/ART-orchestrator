/**
 * ART Report Server
 * Serves the ART reports directory over HTTP so reports can be opened in a
 * browser on any machine (local or remote).
 *
 * Export: startReportServer() — call from index.js to start inline.
 * Direct: node src/report-server.js — starts as standalone process.
 *
 * Env vars:
 *   ART_REPORT_SERVER_PORT  - TCP port (default: 7788)
 *   ART_REPORT_SERVER_HOST  - Hostname for printed URL (default: os.hostname())
 *   REPORT_PATH             - Path to the JSON report; parent dir is served.
 */

import express from 'express';
import { existsSync } from 'fs';
import { resolve, dirname, basename } from 'path';
import { createServer } from 'http';
import { hostname } from 'os';

function buildApp(reportDir, defaultHtml) {
  const app = express();

  app.use((_req, res, next) => {
    res.set('Cache-Control', 'no-store, no-cache, must-revalidate');
    res.set('Pragma', 'no-cache');
    next();
  });

  app.use((_req, res, next) => {
    res.set('Access-Control-Allow-Origin', '*');
    next();
  });

  app.get('/', (_req, res) => res.redirect(`/${defaultHtml}`));

  app.use(express.static(reportDir, { index: false }));

  app.use((req, res) => {
    const htmlExists = existsSync(resolve(reportDir, defaultHtml));
    res.status(404).send(
      `<pre>404 – Not found: ${req.path}\n` +
      `Serving from: ${reportDir}\n` +
      (htmlExists
        ? `Try: <a href="/${defaultHtml}">/${defaultHtml}</a>`
        : `Report not yet generated. Run ART first.`) +
      `</pre>`
    );
  });

  return app;
}

/**
 * Start the report HTTP server in the background.
 * Returns the http.Server instance.
 * Errors are logged but never crash the caller.
 */
export function startReportServer() {
  const port = parseInt(process.env.ART_REPORT_SERVER_PORT || '7788', 10);
  const host = process.env.ART_REPORT_SERVER_HOST || hostname();

  const reportDir = process.env.REPORT_PATH
    ? dirname(resolve(process.cwd(), process.env.REPORT_PATH))
    : resolve(process.cwd(), 'logs');

  const defaultHtml = process.env.REPORT_PATH
    ? basename(process.env.REPORT_PATH, '.json') + '.html'
    : 'art-report.html';

  const server = createServer(buildApp(reportDir, defaultHtml));

  server.listen(port, '0.0.0.0', () => {
    console.log(`ART Report Server listening — open in browser: http://${host}:${port}/${defaultHtml}`);
  });

  server.on('error', (err) => {
    if (err.code === 'EADDRINUSE') {
      console.warn(`Warning: ART report server port ${port} already in use — skipping.`);
    } else {
      console.warn(`Warning: ART report server error: ${err.message}`);
    }
  });

  return server;
}

// ── Standalone mode: node src/report-server.js ──────────────────────────────
import { fileURLToPath } from 'url';
const isMain = process.argv[1] === fileURLToPath(import.meta.url);

if (isMain) {
  await import('./bootstrap-env.js');
  const server = startReportServer();

  const shutdown = () => server.close(() => process.exit(0));
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}
