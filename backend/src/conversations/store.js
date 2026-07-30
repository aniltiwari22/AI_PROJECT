const crypto = require('crypto');
const sqlite = require('../storage/sqlite');

/**
 * Conversation threads.
 *
 * Separate from chat_logs on purpose. chat_logs is an append-only record of
 * every request the system ever served — web, voice and Telegram alike — and
 * exists for the benchmark view. A conversation is a thing you open, rename,
 * scroll back through and delete. Conflating them would mean deleting a thread
 * also deleted the telemetry behind it.
 */

// Long enough that the sidebar stays readable; the full text lives in the row.
const TITLE_LIMIT = 60;

/** First user message makes the title, until someone renames it. */
function titleFrom(text) {
  const clean = String(text || '').replace(/\s+/g, ' ').trim();
  if (!clean) return 'New conversation';
  return clean.length > TITLE_LIMIT ? `${clean.slice(0, TITLE_LIMIT - 1)}…` : clean;
}

function rowToMessage(row) {
  return {
    id: `m-${row.id}`,
    role: row.role,
    text: row.text,
    origin: row.origin || null,
    confidence: row.confidence ?? null,
    sources: row.sources ? JSON.parse(row.sources) : [],
    telemetry: row.telemetry ? JSON.parse(row.telemetry) : null,
    totalMs: row.total_ms ?? null,
    fileIds: row.file_ids ? JSON.parse(row.file_ids) : [],
    createdAt: row.created_at
  };
}

function create({ title } = {}) {
  const now = new Date().toISOString();
  const id = `c_${Date.now()}_${crypto.randomBytes(3).toString('hex')}`;

  sqlite
    .stmt('INSERT INTO conversations (id, title, created_at, updated_at) VALUES (?, ?, ?, ?)')
    .run(id, titleFrom(title), now, now);

  return { id, title: titleFrom(title), createdAt: now, updatedAt: now, pinned: false, messageCount: 0 };
}

function list({ includeArchived = false, limit = 200 } = {}) {
  return sqlite
    .stmt(`SELECT c.id, c.title, c.created_at AS createdAt, c.updated_at AS updatedAt,
                  c.pinned, c.archived,
                  (SELECT COUNT(*) FROM messages m WHERE m.conversation_id = c.id) AS messageCount,
                  (SELECT m.text FROM messages m
                    WHERE m.conversation_id = c.id AND m.role = 'user'
                    ORDER BY m.id DESC LIMIT 1) AS lastUserMessage,
                  (SELECT m.origin FROM messages m
                    WHERE m.conversation_id = c.id AND m.origin IS NOT NULL
                    ORDER BY m.id DESC LIMIT 1) AS lastOrigin
           FROM conversations c
           WHERE (? = 1 OR c.archived = 0)
           ORDER BY c.pinned DESC, c.updated_at DESC
           LIMIT ?`)
    .all(includeArchived ? 1 : 0, Math.min(Number(limit) || 200, 500))
    .map((row) => ({ ...row, pinned: Boolean(row.pinned), archived: Boolean(row.archived) }));
}

function get(id) {
  const conversation = sqlite
    .stmt(`SELECT id, title, created_at AS createdAt, updated_at AS updatedAt, pinned, archived
           FROM conversations WHERE id = ?`)
    .get(id);

  if (!conversation) return null;

  const messages = sqlite
    .stmt('SELECT * FROM messages WHERE conversation_id = ? ORDER BY id ASC')
    .all(id)
    .map(rowToMessage);

  return {
    ...conversation,
    pinned: Boolean(conversation.pinned),
    archived: Boolean(conversation.archived),
    messages
  };
}

/**
 * Appends a message and touches the thread's updated_at, in one transaction so
 * the sidebar order can never disagree with the contents.
 */
function addMessage(conversationId, message) {
  const now = new Date().toISOString();

  return sqlite.transaction(() => {
    const exists = sqlite.stmt('SELECT title FROM conversations WHERE id = ?').get(conversationId);
    if (!exists) {
      const error = new Error('No such conversation');
      error.statusCode = 404;
      throw error;
    }

    const result = sqlite
      .stmt(`INSERT INTO messages
               (conversation_id, role, text, origin, confidence, sources, telemetry,
                total_ms, file_ids, created_at)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(
        conversationId,
        message.role === 'assistant' ? 'assistant' : message.role === 'error' ? 'error' : 'user',
        String(message.text ?? ''),
        message.origin || null,
        typeof message.confidence === 'number' ? message.confidence : null,
        message.sources ? JSON.stringify(message.sources) : null,
        message.telemetry ? JSON.stringify(message.telemetry) : null,
        message.totalMs ?? null,
        message.fileIds?.length ? JSON.stringify(message.fileIds) : null,
        now
      );

    sqlite.stmt('UPDATE conversations SET updated_at = ? WHERE id = ?').run(now, conversationId);

    // An untitled thread takes its name from the first thing asked in it.
    if (exists.title === 'New conversation' && message.role === 'user') {
      sqlite.stmt('UPDATE conversations SET title = ? WHERE id = ?')
        .run(titleFrom(message.text), conversationId);
    }

    return { id: `m-${result.lastInsertRowid}`, createdAt: now };
  })();
}

function rename(id, title) {
  const clean = String(title || '').trim().slice(0, 200);
  if (!clean) {
    const error = new Error('Title cannot be empty');
    error.statusCode = 400;
    throw error;
  }
  const result = sqlite
    .stmt('UPDATE conversations SET title = ?, updated_at = ? WHERE id = ?')
    .run(clean, new Date().toISOString(), id);
  return { renamed: result.changes > 0, title: clean };
}

function setFlag(id, field, value) {
  if (!['pinned', 'archived'].includes(field)) throw new Error('Unsupported field');
  const result = sqlite
    .stmt(`UPDATE conversations SET ${field} = ? WHERE id = ?`)
    .run(value ? 1 : 0, id);
  return { updated: result.changes > 0 };
}

function remove(id) {
  // messages cascade via the foreign key, and the FTS triggers follow.
  const result = sqlite.stmt('DELETE FROM conversations WHERE id = ?').run(id);
  return { deleted: result.changes > 0 };
}

// FTS5 treats punctuation as syntax, so a raw sentence is a syntax error.
function toMatchQuery(query) {
  const terms = String(query)
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((t) => t.length > 1);
  return terms.map((t) => `"${t}"*`).join(' OR ');
}

/** Full-text search across every message, newest thread first. */
function search(query, { limit = 30 } = {}) {
  const match = toMatchQuery(query);
  if (!match) return [];

  return sqlite
    .stmt(`SELECT m.conversation_id AS conversationId, c.title, m.role,
                  snippet(messages_fts, 0, '', '', '…', 12) AS snippet,
                  m.created_at AS createdAt
           FROM messages_fts
           JOIN messages m ON m.id = messages_fts.rowid
           JOIN conversations c ON c.id = m.conversation_id
           WHERE messages_fts MATCH ?
           ORDER BY bm25(messages_fts) LIMIT ?`)
    .all(match, Math.min(Number(limit) || 30, 100));
}

function stats() {
  const row = sqlite
    .stmt(`SELECT (SELECT COUNT(*) FROM conversations) AS conversations,
                  (SELECT COUNT(*) FROM messages) AS messages`)
    .get();
  return row;
}

module.exports = {
  create, list, get, addMessage, rename, setFlag, remove, search, stats, titleFrom
};
