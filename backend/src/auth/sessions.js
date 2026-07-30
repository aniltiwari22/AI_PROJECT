const crypto = require('crypto');
const sqlite = require('../storage/sqlite');

/**
 * Opaque session tokens, stored hashed in SQLite.
 *
 * Chosen over JWT deliberately. A JWT cannot be revoked without a server-side
 * list anyway, so it would need this table regardless — and it adds a signing
 * key to manage plus a family of algorithm-confusion mistakes to avoid. A
 * random 256-bit token looked up in a table has none of that.
 *
 * The token is hashed at rest. Someone who reads ashu.db gets hashes, not
 * usable logins. SHA-256 is right here (unlike for passwords) because the
 * token is already 256 bits of entropy — there is nothing to brute-force.
 *
 * Replaces a static string, 'codex_bearer_secure_token', that was identical
 * for every login and never expired.
 */

const TTL_MS = Number(process.env.AUTH_SESSION_TTL_MS || 30 * 24 * 60 * 60 * 1000);

function hashToken(token) {
  return crypto.createHash('sha256').update(token).digest('hex');
}

function issue({ label = 'web', ttlMs = TTL_MS } = {}) {
  const token = crypto.randomBytes(32).toString('base64url');
  const now = Date.now();

  sqlite
    .stmt(`INSERT INTO sessions (token_hash, label, created_at, last_seen, expires_at)
           VALUES (?, ?, ?, ?, ?)`)
    .run(hashToken(token), label, now, now, now + ttlMs);

  // Opportunistic cleanup — no scheduler needed for a single-user app.
  sqlite.stmt('DELETE FROM sessions WHERE expires_at < ?').run(now);

  return { token, expiresAt: now + ttlMs };
}

/** @returns the session row, or null if the token is unknown or expired. */
function verify(token) {
  if (typeof token !== 'string' || !token) return null;

  const row = sqlite
    .stmt('SELECT id, label, created_at, expires_at FROM sessions WHERE token_hash = ?')
    .get(hashToken(token));

  if (!row) return null;

  const now = Date.now();
  if (row.expires_at < now) {
    sqlite.stmt('DELETE FROM sessions WHERE id = ?').run(row.id);
    return null;
  }

  // Written at most once a minute: every request would otherwise be a write,
  // turning read-only API calls into database traffic.
  if (now - (row.last_seen || 0) > 60_000) {
    sqlite.stmt('UPDATE sessions SET last_seen = ? WHERE id = ?').run(now, row.id);
  }

  return row;
}

function revoke(token) {
  const result = sqlite.stmt('DELETE FROM sessions WHERE token_hash = ?').run(hashToken(token));
  return result.changes > 0;
}

function revokeAll() {
  return sqlite.stmt('DELETE FROM sessions').run().changes;
}

function list() {
  return sqlite
    .stmt(`SELECT id, label, created_at AS createdAt, last_seen AS lastSeen, expires_at AS expiresAt
           FROM sessions ORDER BY last_seen DESC`)
    .all();
}

module.exports = { issue, verify, revoke, revokeAll, list, TTL_MS };
