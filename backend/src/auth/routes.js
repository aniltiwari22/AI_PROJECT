const express = require('express');
const { verifyPassword } = require('./passwords');
const sessions = require('./sessions');
const { bearerFrom, PASSWORD_HASH } = require('./middleware');

const router = express.Router();

/**
 * Replaces a router that accepted the literal credentials admin/codex and
 * returned the same hardcoded token to everybody, forever — a token which no
 * route then checked.
 */

// Login is the one unauthenticated endpoint that does real work, so it is the
// one worth guessing against. scrypt already makes each attempt cost ~100 ms;
// this caps how many attempts are possible at all.
const MAX_ATTEMPTS = Number(process.env.AUTH_MAX_ATTEMPTS || 10);
const LOCKOUT_MS = Number(process.env.AUTH_LOCKOUT_MS || 15 * 60 * 1000);
const attempts = new Map();

function throttle(key) {
  const now = Date.now();
  const record = attempts.get(key);

  if (!record || now > record.until) {
    attempts.set(key, { count: 0, until: now + LOCKOUT_MS });
    return { blocked: false };
  }
  if (record.count >= MAX_ATTEMPTS) {
    return { blocked: true, retryAfterSec: Math.ceil((record.until - now) / 1000) };
  }
  return { blocked: false };
}

function recordFailure(key) {
  const record = attempts.get(key);
  if (record) record.count += 1;
}

router.post('/login', (req, res) => {
  const key = req.ip || 'unknown';
  const gate = throttle(key);

  if (gate.blocked) {
    return res.status(429).json({
      success: false,
      error: `Too many attempts. Try again in ${gate.retryAfterSec}s.`
    });
  }

  const { password, label } = req.body || {};

  if (!verifyPassword(typeof password === 'string' ? password : '', PASSWORD_HASH)) {
    recordFailure(key);
    // No hint about whether a password is even configured.
    return res.status(401).json({ success: false, error: 'Incorrect password' });
  }

  attempts.delete(key);
  const { token, expiresAt } = sessions.issue({
    label: typeof label === 'string' && label.trim() ? label.trim().slice(0, 40) : 'web'
  });

  return res.status(200).json({ success: true, token, expiresAt });
});

router.post('/logout', (req, res) => {
  res.json({ success: true, revoked: sessions.revoke(bearerFrom(req)) });
});

/** Lets the UI decide whether to show a login screen, without leaking anything. */
router.get('/status', (req, res) => {
  res.json({
    success: true,
    configured: Boolean(PASSWORD_HASH),
    authenticated: Boolean(sessions.verify(bearerFrom(req)))
  });
});

router.get('/sessions', (req, res) => {
  res.json({ success: true, sessions: sessions.list() });
});

/** Signs every device out — the response to a token you think has leaked. */
router.post('/sessions/revoke-all', (req, res) => {
  res.json({ success: true, revoked: sessions.revokeAll() });
});

module.exports = router;
