#!/usr/bin/env node
const http = require('http');
const fs = require('fs');
const path = require('path');

/**
 * One port serving both the built frontend and the API.
 *
 * Needed for any single-URL deployment — a tunnel, or a bare VPS without
 * Caddy. The frontend calls the API at a relative path, so browser and API
 * share an origin: CORS stops applying entirely, and there is no second URL to
 * configure or leak.
 *
 * Zero dependencies on purpose. This runs in front of everything, so it should
 * not pull in a package tree of its own.
 *
 *   node deploy/edge.js            # :8080
 *   PORT=9000 node deploy/edge.js
 */

const PORT = Number(process.env.EDGE_PORT || 8080);
const BACKEND = process.env.EDGE_BACKEND || 'http://127.0.0.1:5000';
const ROOT = path.resolve(__dirname, '../frontend/dist');

const backend = new URL(BACKEND);
const API_PREFIXES = ['/api/', '/health', '/ping'];

const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2'
};

function isApi(url) {
  return API_PREFIXES.some((p) => url === p || url.startsWith(p));
}

function proxy(req, res) {
  const upstream = http.request(
    {
      hostname: backend.hostname,
      port: backend.port,
      path: req.url,
      method: req.method,
      headers: { ...req.headers, host: backend.host }
    },
    (upstreamRes) => {
      res.writeHead(upstreamRes.statusCode, upstreamRes.headers);
      // Piped, never buffered: chat and repo indexing stream NDJSON for
      // minutes, and buffering would hold every progress event until the end.
      upstreamRes.pipe(res);
    }
  );

  upstream.on('error', (error) => {
    if (res.headersSent) return res.destroy();
    res.writeHead(502, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ success: false, error: `Backend unreachable: ${error.message}` }));
  });

  // If the client hangs up mid-stream, stop work upstream too rather than
  // leaving a generation running against nobody.
  req.on('aborted', () => upstream.destroy());
  req.pipe(upstream);
}

function serveStatic(req, res) {
  // Strip the query and refuse anything that climbs out of dist/.
  const requested = decodeURIComponent((req.url || '/').split('?')[0]);
  const resolved = path.join(ROOT, requested);

  if (!resolved.startsWith(ROOT)) {
    res.writeHead(403).end('Forbidden');
    return;
  }

  let file = resolved;
  if (!fs.existsSync(file) || fs.statSync(file).isDirectory()) {
    // Single-page app: unknown paths are routes, not missing files.
    file = path.join(ROOT, 'index.html');
  }

  if (!fs.existsSync(file)) {
    res.writeHead(404).end('Build the frontend first: npm run build');
    return;
  }

  const ext = path.extname(file).toLowerCase();
  res.writeHead(200, {
    'Content-Type': TYPES[ext] || 'application/octet-stream',
    // index.html must never be cached or a deploy leaves stale JS references;
    // hashed assets are safe to cache forever.
    'Cache-Control': file.endsWith('index.html') ? 'no-cache' : 'public, max-age=31536000, immutable',
    'X-Content-Type-Options': 'nosniff'
  });
  fs.createReadStream(file).pipe(res);
}

http
  .createServer((req, res) => (isApi(req.url || '') ? proxy(req, res) : serveStatic(req, res)))
  .listen(PORT, '127.0.0.1', () => {
    console.log(`edge  http://127.0.0.1:${PORT}`);
    console.log(`      static  ${ROOT}`);
    console.log(`      api     ${BACKEND}`);
    if (!fs.existsSync(path.join(ROOT, 'index.html'))) {
      console.warn('      WARNING: frontend/dist is empty — run npm run build');
    }
  });
