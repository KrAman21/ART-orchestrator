/**
 * ART Report Server
 * Serves the ART reports directory over HTTP so reports can be opened in a
 * browser on any machine (local or remote).
 *
 * Configured via environment variables:
 *   ART_REPORT_SERVER_PORT  - TCP port to listen on (default: 7788)
 *   REPORT_PATH             - Path to the JSON report; the parent directory
 *                             is served as the document root. If unset, the
 *                             `logs/` directory relative to CWD is used.
 */

import './bootstrap-env.js';

import express from 'express';
import { existsSync } from 'fs';
import { resolve, dirname, basename } from 'path';
import { createServer } from 'http';
import { hostname } from 'os';

const PORT = parseInt(process.env.ART_REPORT_SERVER_PORT || '7788', 10);
const HOST = process.env.ART_REPORT_SERVER_HOST || hostname();

const REPORT_DIR = process.env.REPORT_PATH
  ? dirname(resolve(process.cwd(), process.env.REPORT_PATH))
  : resolve(process.cwd(), 'logs');

const DEFAULT_HTML = process.env.REPORT_PATH
  ? basename(process.env.REPORT_PATH, '.json') + '.html'
  : 'art-report.html';

const app = express();

// Disable caching so refreshing the browser always shows the latest report
app.use((_req, res, next) => {
  res.set('Cache-Control', 'no-store, no-cache, must-revalidate');
  res.set('Pragma', 'no-cache');
  next();
});

// CORS – allow any origin so an SSH-tunnelled browser can reach the server
app.use((_req, res, next) => {
  res.set('Access-Control-Allow-Origin', '*');
  next();
});

// Redirect bare root to the default HTML report
app.get('/', (_req, res) => {
  res.redirect(`/${DEFAULT_HTML}`);
});

// Serve everything in REPORT_DIR
app.use(express.static(REPORT_DIR, { index: false }));

// 404 fallback with a helpful message
app.use((req, res) => {
  const attempted = resolve(REPORT_DIR, req.path.replace(/^\//, ''));
  const htmlExists = existsSync(resolve(REPORT_DIR, DEFAULT_HTML));
  res.status(404).send(
    `<pre>404 – Not found: ${req.path}\n` +
    `Serving from: ${REPORT_DIR}\n` +
    (htmlExists
      ? `Try: <a href="/${DEFAULT_HTML}">/${DEFAULT_HTML}</a>`
      : `Report not yet generated. Run ART first.`) +
    `</pre>`
  );
});

const server = createServer(app);

server.listen(PORT, '0.0.0.0', () => {
  console.log(`ART Report Server listening on http://0.0.0.0:${PORT}`);
  console.log(`  Serving: ${REPORT_DIR}`);
  console.log(`  Default: http://${HOST}:${PORT}/${DEFAULT_HTML}`);
});

server.on('error', (err) => {
  if (err.code === 'EADDRINUSE') {
    console.error(`Port ${PORT} is already in use. Set ART_REPORT_SERVER_PORT to a different port.`);
  } else {
    console.error('Report server error:', err.message);
  }
  process.exit(1);
});

// Graceful shutdown on SIGINT / SIGTERM (sent by process-compose)
const shutdown = () => {
  server.close(() => process.exit(0));
};
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
