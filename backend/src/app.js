const express = require('express');
const cors = require('cors');
const helmet = require('helmet');
const path = require('path');
require('dotenv').config({ path: path.resolve(__dirname, '../../.env') });

const chatRoutes = require('./routes/route1');
const authRoutes = require('./auth/routes');
const knowledgeRoutes = require('./knowledge/routes');
const fileRoutes = require('./files/routes');
const analyticsRoutes = require('./analytics/routes');
const voiceRoutes = require('./voice/routes');
const conversationRoutes = require('./conversations/routes');
const { checkDatabase } = require('./config/db');
const { checkOllama, visionStatus } = require('./config/ollama');
const { getTelegramStatus } = require('./services/telegramBot');
const { webSearchStatus } = require('./search/webSearch');
const vectorStore = require('./knowledge/vectorStore');
const excelStore = require('./knowledge/excelStore');
const semanticCache = require('./knowledge/semanticCache');
const excelLogger = require('./logging/excelLogger');
const { errorHandler } = require('./middleware/middleware1');
const { requireAuth, assertConfigured } = require('./auth/middleware');

const app = express();

// Refuse to start without a password rather than starting wide open.
assertConfigured();

// Behind a reverse proxy (nginx, Cloudflare, a tunnel) every request appears
// to come from the proxy, so the login lockout would count all attempts from
// everyone against one bucket — and lock the whole world out after ten wrong
// guesses. Only enable this when a proxy is genuinely in front: trusting
// X-Forwarded-For when nothing sets it lets a client forge its own address.
if (process.env.TRUST_PROXY) app.set('trust proxy', process.env.TRUST_PROXY);

app.use(helmet());

/*
 * CORS was `*`, which let any page on the internet call this API with the
 * browser's credentials. Default is now localhost only; set CORS_ORIGIN to a
 * comma-separated list when serving from a real hostname.
 */
const ALLOWED_ORIGINS = (process.env.CORS_ORIGIN || 'http://localhost:5173,http://127.0.0.1:5173')
  .split(',')
  .map((o) => o.trim())
  .filter(Boolean);

/**
 * Same-origin requests are always allowed, whatever the host happens to be.
 *
 * Browsers send an Origin header on same-origin POSTs too, not only on
 * cross-origin ones. Matching solely against a configured list therefore
 * rejected the app calling its own API — which is exactly what happens behind
 * a tunnel or any hostname not known when CORS_ORIGIN was written. It also
 * hid the problem from curl, which sends no Origin at all.
 *
 * Comparing the Origin to the request's own Host keeps that working without
 * having to predict the hostname, and gives away nothing: a page on another
 * origin cannot forge Host.
 */
function isSameOrigin(origin, req) {
  if (!origin || !req.headers.host) return false;
  try {
    return new URL(origin).host === req.headers.host;
  } catch {
    return false;
  }
}

app.use(cors((req, callback) => {
  const origin = req.headers.origin;

  // No Origin header at all: curl, a native client, a server-to-server call.
  if (!origin) return callback(null, { origin: true, credentials: true });

  if (isSameOrigin(origin, req) || ALLOWED_ORIGINS.includes('*') || ALLOWED_ORIGINS.includes(origin)) {
    return callback(null, { origin: true, credentials: true });
  }

  // Not an error — an error becomes a 500 and looks like the server is broken.
  // Withholding the header is what CORS actually does: the request is served,
  // and the browser refuses to let the other site read the response.
  return callback(null, { origin: false });
}));

app.use(express.json({ limit: process.env.JSON_BODY_LIMIT || '30mb' }));

// Everything under /api needs a session except login and status. Mounted
// before the routers so no route can be added later that forgets to check.
app.use('/api', requireAuth);

app.use('/api/v1/chat', chatRoutes);
app.use('/api/v1/auth', authRoutes);
app.use('/api/v1/knowledge', knowledgeRoutes);
app.use('/api/v1/files', fileRoutes);
app.use('/api/v1/analytics', analyticsRoutes);
app.use('/api/v1/conversations', conversationRoutes);
app.use('/api/v2/voice', voiceRoutes);

// Unauthenticated liveness only — says nothing about the machine. Monitoring
// and container health checks use this; /health needs a session because it
// reports absolute filesystem paths, model names and store contents.
app.get('/ping', (req, res) => res.json({ ok: true }));

app.get('/health', requireAuth, async (req, res) => {
  const health = {
    status: 'healthy',
    system: 'Ashu Codex AI Engine'
  };

  try {
    health.database = await checkDatabase();
  } catch (error) {
    health.status = 'degraded';
    health.database = {
      connected: false,
      error: error.message
    };
  }

  try {
    health.ollama = await checkOllama();
  } catch (error) {
    health.status = 'degraded';
    health.ollama = {
      connected: false,
      baseUrl: process.env.OLLAMA_BASE_URL || 'http://localhost:11434',
      error: error.message
    };
  }

  health.telegram = getTelegramStatus();
  health.webSearch = webSearchStatus();

  // Image reading depends on a separate model; without this, /health claimed
  // everything was fine while uploads of images would fail.
  try {
    health.vision = await visionStatus();
  } catch (error) {
    health.vision = { enabled: false, error: error.message };
  }

  // Each subsystem reports independently: one failing store should show up as
  // that store's error, not hide the health of everything else.
  const subsystems = [
    ['knowledge', () => vectorStore.stats()],
    ['excel', () => excelStore.stats()],
    ['cache', () => semanticCache.stats()],
    ['logs', () => excelLogger.stats()]
  ];

  for (const [key, read] of subsystems) {
    try {
      health[key] = await read();
    } catch (error) {
      health[key] = { error: error.message };
    }
  }

  res.status(health.status === 'healthy' ? 200 : 503).json(health);
});

// Express's default 404 is an HTML page. A client calling response.json() on
// that fails with "Unexpected token <" instead of showing the real problem, so
// unmatched API routes answer in the same shape as every other endpoint.
app.use('/api', (req, res) => {
  res.status(404).json({
    success: false,
    error: `No such endpoint: ${req.method} ${req.originalUrl}`
  });
});

app.use(errorHandler);

module.exports = app;
