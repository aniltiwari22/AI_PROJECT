const sqlite = require('../storage/sqlite');

/**
 * Chat log persistence.
 *
 * Was a single JSON file rewritten in full on every insert — 136KB rewritten
 * to append a 200-byte row, and before the write queue existed, 24 of 25
 * concurrent inserts were silently lost. SQLite writes the row.
 *
 * The API stays async so nothing upstream changes, even though better-sqlite3
 * is synchronous.
 */

async function insertChatLog({ prompt, response }) {
  const createdAt = new Date().toISOString();

  const result = sqlite
    .stmt('INSERT INTO chat_logs (prompt, response, created_at) VALUES (?, ?, ?)')
    .run(String(prompt ?? ''), String(response ?? ''), createdAt);

  return { id: result.lastInsertRowid, prompt, response, createdAt };
}

async function checkDatabase() {
  const { n } = sqlite.stmt('SELECT COUNT(*) AS n FROM chat_logs').get();

  return {
    connected: true,
    file: sqlite.DB_FILE,
    engine: 'sqlite',
    chatLogCount: n
  };
}

/** Most recent first. Used by the replay view and for ad-hoc inspection. */
async function recentChatLogs(limit = 50) {
  return sqlite
    .stmt('SELECT id, prompt, response, created_at AS createdAt FROM chat_logs ORDER BY id DESC LIMIT ?')
    .all(Math.max(1, Math.min(Number(limit) || 50, 500)));
}

module.exports = {
  DB_FILE: sqlite.DB_FILE,
  checkDatabase,
  insertChatLog,
  recentChatLogs
};
