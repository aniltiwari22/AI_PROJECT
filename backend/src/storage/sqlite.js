const path = require('path');
const fs = require('fs');
const Database = require('better-sqlite3');

/**
 * One SQLite database for everything the app records.
 *
 * Replaces four JSON files that were each rewritten in full on every write.
 * The cache was the worst case: 15.4KB per entry, so at its 500-entry cap a
 * single new answer re-read and re-wrote 7.5MB.
 *
 * Excel is deliberately still Excel. knowledge.xlsx is something a person
 * edits by hand, so it stays a workbook; the request and voice logs are
 * written here and exported to .xlsx on demand instead.
 */

const PROJECT_ROOT = path.resolve(__dirname, '../../..');
const DB_FILE = process.env.SQLITE_FILE
  ? path.resolve(PROJECT_ROOT, process.env.SQLITE_FILE)
  : path.resolve(PROJECT_ROOT, 'storage/ashu.db');

const SCHEMA = `
CREATE TABLE IF NOT EXISTS chat_logs (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  prompt     TEXT NOT NULL,
  response   TEXT,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_chat_logs_created ON chat_logs(created_at);

/* Threads the UI can switch between. chat_logs stays as it is — that is an
   append-only audit of every request, including Telegram and voice, and is not
   the same thing as a browsable conversation. */
CREATE TABLE IF NOT EXISTS conversations (
  id         TEXT PRIMARY KEY,
  title      TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  pinned     INTEGER NOT NULL DEFAULT 0,
  archived   INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_conversations_updated ON conversations(updated_at DESC);

CREATE TABLE IF NOT EXISTS messages (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  conversation_id TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  role            TEXT NOT NULL,
  text            TEXT NOT NULL,
  origin          TEXT,
  confidence      REAL,
  sources         TEXT,
  telemetry       TEXT,
  total_ms        INTEGER,
  file_ids        TEXT,
  created_at      TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_messages_conversation ON messages(conversation_id, id);

/* Searching your own history is the point of keeping it. */
CREATE VIRTUAL TABLE IF NOT EXISTS messages_fts
  USING fts5(text, content='messages', content_rowid='id');

CREATE TRIGGER IF NOT EXISTS messages_ai AFTER INSERT ON messages BEGIN
  INSERT INTO messages_fts(rowid, text) VALUES (new.id, new.text);
END;
CREATE TRIGGER IF NOT EXISTS messages_ad AFTER DELETE ON messages BEGIN
  INSERT INTO messages_fts(messages_fts, rowid, text) VALUES ('delete', old.id, old.text);
END;
CREATE TRIGGER IF NOT EXISTS messages_au AFTER UPDATE ON messages BEGIN
  INSERT INTO messages_fts(messages_fts, rowid, text) VALUES ('delete', old.id, old.text);
  INSERT INTO messages_fts(rowid, text) VALUES (new.id, new.text);
END;

CREATE TABLE IF NOT EXISTS files (
  id         TEXT PRIMARY KEY,
  filename   TEXT NOT NULL,
  kind       TEXT,
  mime_type  TEXT,
  bytes      INTEGER,
  chars      INTEGER,
  truncated  INTEGER DEFAULT 0,
  text       TEXT,
  warning    TEXT,
  meta       TEXT,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_files_created ON files(created_at);

CREATE TABLE IF NOT EXISTS documents (
  id          TEXT PRIMARY KEY,
  title       TEXT,
  source      TEXT,
  chunk_count INTEGER,
  created_at  TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS chunks (
  rowid      INTEGER PRIMARY KEY,
  id         TEXT UNIQUE NOT NULL,
  doc_id     TEXT NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
  title      TEXT,
  source     TEXT,
  text       TEXT NOT NULL,
  embedding  BLOB,
  /* Null for prose. For code these carry the range in the original file, so a
     citation can point at db.js:14-22 rather than at an anonymous fragment. */
  start_line INTEGER,
  end_line   INTEGER
);
CREATE INDEX IF NOT EXISTS idx_chunks_doc ON chunks(doc_id);

/* Replaces the hand-rolled keyword scorer used when embeddings are down. */
CREATE VIRTUAL TABLE IF NOT EXISTS chunks_fts
  USING fts5(text, content='chunks', content_rowid='rowid');

CREATE TRIGGER IF NOT EXISTS chunks_ai AFTER INSERT ON chunks BEGIN
  INSERT INTO chunks_fts(rowid, text) VALUES (new.rowid, new.text);
END;
CREATE TRIGGER IF NOT EXISTS chunks_ad AFTER DELETE ON chunks BEGIN
  INSERT INTO chunks_fts(chunks_fts, rowid, text) VALUES ('delete', old.rowid, old.text);
END;
CREATE TRIGGER IF NOT EXISTS chunks_au AFTER UPDATE ON chunks BEGIN
  INSERT INTO chunks_fts(chunks_fts, rowid, text) VALUES ('delete', old.rowid, old.text);
  INSERT INTO chunks_fts(rowid, text) VALUES (new.rowid, new.text);
END;

CREATE TABLE IF NOT EXISTS cache (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  question   TEXT NOT NULL,
  answer     TEXT NOT NULL,
  origin     TEXT,
  sources    TEXT,
  embedding  BLOB,
  created_at INTEGER NOT NULL,
  last_used  INTEGER NOT NULL,
  hits       INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_cache_last_used ON cache(last_used);

CREATE TABLE IF NOT EXISTS request_logs (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  at          TEXT NOT NULL,
  user        TEXT,
  question    TEXT,
  origin      TEXT,
  confidence  REAL,
  response_ms INTEGER,
  model       TEXT,
  answer      TEXT,
  sources     TEXT
);
CREATE INDEX IF NOT EXISTS idx_request_logs_at ON request_logs(at);

/* Session tokens are stored as SHA-256 hashes, never in the clear, so reading
   this file does not hand anyone a working login. */
CREATE TABLE IF NOT EXISTS sessions (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  token_hash TEXT UNIQUE NOT NULL,
  label      TEXT,
  created_at INTEGER NOT NULL,
  last_seen  INTEGER NOT NULL,
  expires_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_sessions_expires ON sessions(expires_at);

CREATE TABLE IF NOT EXISTS voice_logs (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  at          TEXT NOT NULL,
  session_id  TEXT,
  language    TEXT,
  transcript  TEXT,
  origin      TEXT,
  confidence  REAL,
  response_ms INTEGER,
  answer      TEXT,
  spoken      INTEGER,
  interrupted INTEGER
);
CREATE INDEX IF NOT EXISTS idx_voice_logs_at ON voice_logs(at);
`;

let db = null;

function connect() {
  if (db) return db;

  fs.mkdirSync(path.dirname(DB_FILE), { recursive: true });
  db = new Database(DB_FILE);

  // WAL lets reads continue during a write and survives a crash mid-write.
  db.pragma('journal_mode = WAL');
  // NORMAL trades an fsync per commit for one per checkpoint. Safe under WAL
  // for anything short of an OS crash, and this is a local single-user app.
  db.pragma('synchronous = NORMAL');
  db.pragma('foreign_keys = ON');

  db.exec(SCHEMA);
  migrate(db);
  return db;
}

/**
 * Additive column migrations. CREATE TABLE IF NOT EXISTS does nothing to a
 * table that already exists, so a database created before a column was added
 * would be missing it and every insert would fail.
 */
function migrate(handle) {
  const columns = (table) => handle.prepare(`PRAGMA table_info(${table})`).all().map((c) => c.name);

  const chunkColumns = columns('chunks');
  if (!chunkColumns.includes('start_line')) {
    handle.exec('ALTER TABLE chunks ADD COLUMN start_line INTEGER');
  }
  if (!chunkColumns.includes('end_line')) {
    handle.exec('ALTER TABLE chunks ADD COLUMN end_line INTEGER');
  }
}

/**
 * Embeddings are 768 float32s. Stored as JSON they cost ~15KB per row; as a
 * packed BLOB they cost 3KB and need no parsing to read back.
 */
function packEmbedding(vector) {
  if (!Array.isArray(vector) || !vector.length) return null;
  return Buffer.from(new Float32Array(vector).buffer);
}

function unpackEmbedding(blob) {
  if (!blob || !blob.length) return null;
  // Float32Array must not straddle the pool Buffer, so copy the exact window.
  const copy = Buffer.from(blob);
  return Array.from(new Float32Array(copy.buffer, copy.byteOffset, copy.length / 4));
}

// Prepared statements are cached by better-sqlite3 per Statement object, so
// preparing once and reusing avoids re-parsing SQL on every call.
const cachedStatements = new Map();

function stmt(sql) {
  let prepared = cachedStatements.get(sql);
  if (!prepared) {
    prepared = connect().prepare(sql);
    cachedStatements.set(sql, prepared);
  }
  return prepared;
}

function transaction(fn) {
  return connect().transaction(fn);
}

function close() {
  if (!db) return;
  db.close();
  db = null;
  cachedStatements.clear();
}

module.exports = { DB_FILE, connect, stmt, transaction, packEmbedding, unpackEmbedding, close };
