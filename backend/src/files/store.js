const crypto = require('crypto');
const sqlite = require('../storage/sqlite');

// Uploaded documents can be large; only a bounded slice is ever fed to the
// model, and the rest is kept for reference.
const MAX_STORED_CHARS = Number(process.env.UPLOAD_MAX_STORED_CHARS || 200000);

function rowToFile(row) {
  if (!row) return null;
  return {
    id: row.id,
    filename: row.filename,
    kind: row.kind,
    mimeType: row.mime_type || '',
    bytes: row.bytes,
    chars: row.chars,
    truncated: Boolean(row.truncated),
    text: row.text || '',
    warning: row.warning || null,
    meta: row.meta ? JSON.parse(row.meta) : {},
    createdAt: row.created_at
  };
}

async function saveFile({ filename, kind, mimeType, text, warning, meta, bytes }) {
  const body = String(text ?? '');
  const record = {
    id: `file_${Date.now()}_${crypto.randomBytes(4).toString('hex')}`,
    filename,
    kind,
    mimeType: mimeType || '',
    bytes,
    chars: body.length,
    truncated: body.length > MAX_STORED_CHARS,
    text: body.slice(0, MAX_STORED_CHARS),
    warning: warning || null,
    meta: meta || {},
    createdAt: new Date().toISOString()
  };

  sqlite
    .stmt(`INSERT INTO files
             (id, filename, kind, mime_type, bytes, chars, truncated, text, warning, meta, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
    .run(
      record.id, record.filename, record.kind, record.mimeType, record.bytes,
      record.chars, record.truncated ? 1 : 0, record.text, record.warning,
      JSON.stringify(record.meta), record.createdAt
    );

  return record;
}

async function getFiles(ids = []) {
  if (!ids.length) return [];
  // Parameterised IN list — never interpolate ids into the SQL.
  const holes = ids.map(() => '?').join(',');
  return sqlite.stmt(`SELECT * FROM files WHERE id IN (${holes})`).all(...ids).map(rowToFile);
}

async function listFiles() {
  // Text bodies are large; the listing only needs metadata plus a preview, so
  // the substring happens in SQL rather than loading every document into Node.
  return sqlite
    .stmt(`SELECT id, filename, kind, mime_type, bytes, chars, truncated, warning, meta, created_at,
                  substr(text, 1, 200) AS preview
           FROM files ORDER BY created_at ASC`)
    .all()
    .map((row) => ({
      id: row.id,
      filename: row.filename,
      kind: row.kind,
      mimeType: row.mime_type || '',
      bytes: row.bytes,
      chars: row.chars,
      truncated: Boolean(row.truncated),
      warning: row.warning || null,
      meta: row.meta ? JSON.parse(row.meta) : {},
      createdAt: row.created_at,
      preview: row.preview || ''
    }));
}

async function deleteFile(id) {
  const result = sqlite.stmt('DELETE FROM files WHERE id = ?').run(id);
  return { deleted: result.changes > 0 };
}

async function stats() {
  const { n } = sqlite.stmt('SELECT COUNT(*) AS n FROM files').get();
  return { count: n, file: sqlite.DB_FILE };
}

module.exports = { saveFile, getFiles, listFiles, deleteFile, stats, MAX_STORED_CHARS };
