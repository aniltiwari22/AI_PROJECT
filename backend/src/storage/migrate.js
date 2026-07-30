const fs = require('fs');
const path = require('path');
const sqlite = require('./sqlite');

/**
 * One-way import from the JSON stores into SQLite.
 *
 * Non-destructive by design: the JSON files are read and left exactly as they
 * are, so the old data remains a working fallback until you delete it.
 *
 * Idempotent: rows are matched on their natural keys, so running it twice
 * imports nothing the second time rather than duplicating everything.
 *
 *   node src/storage/migrate.js          import
 *   node src/storage/migrate.js --check  report what would be imported
 */

const PROJECT_ROOT = path.resolve(__dirname, '../../..');

function readJson(relative, fallback) {
  const file = path.resolve(PROJECT_ROOT, relative);
  try {
    const raw = fs.readFileSync(file, 'utf8');
    return raw.trim() ? JSON.parse(raw) : fallback;
  } catch (error) {
    if (error.code !== 'ENOENT') console.warn(`  ${relative}: ${error.message}`);
    return fallback;
  }
}

function migrateChatLogs(dryRun) {
  const rows = readJson('storage/database.json', { chat_logs: [] }).chat_logs || [];
  if (dryRun) return { total: rows.length, imported: 0 };

  // created_at is unique enough in practice; prompt disambiguates same-ms rows.
  const exists = sqlite.stmt('SELECT 1 FROM chat_logs WHERE created_at = ? AND prompt = ?');
  const insert = sqlite.stmt('INSERT INTO chat_logs (prompt, response, created_at) VALUES (?, ?, ?)');

  let imported = 0;
  sqlite.transaction(() => {
    for (const row of rows) {
      const prompt = String(row.prompt ?? '');
      const createdAt = String(row.createdAt ?? new Date().toISOString());
      if (exists.get(createdAt, prompt)) continue;
      insert.run(prompt, String(row.response ?? ''), createdAt);
      imported += 1;
    }
  })();

  return { total: rows.length, imported };
}

function migrateFiles(dryRun) {
  const rows = readJson('storage/files.json', { files: [] }).files || [];
  if (dryRun) return { total: rows.length, imported: 0 };

  const insert = sqlite.stmt(`
    INSERT OR IGNORE INTO files
      (id, filename, kind, mime_type, bytes, chars, truncated, text, warning, meta, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);

  let imported = 0;
  sqlite.transaction(() => {
    for (const f of rows) {
      const result = insert.run(
        f.id, f.filename, f.kind || null, f.mimeType || null,
        f.bytes ?? null, f.chars ?? null, f.truncated ? 1 : 0,
        f.text || '', f.warning || null,
        f.meta ? JSON.stringify(f.meta) : null,
        f.createdAt || new Date().toISOString()
      );
      imported += result.changes;
    }
  })();

  return { total: rows.length, imported };
}

function migrateKnowledge(dryRun) {
  const store = readJson('storage/knowledge.json', { documents: [], chunks: [] });
  const documents = store.documents || [];
  const chunks = store.chunks || [];
  if (dryRun) return { total: documents.length, imported: 0, chunks: chunks.length };

  const insertDoc = sqlite.stmt(`
    INSERT OR IGNORE INTO documents (id, title, source, chunk_count, created_at) VALUES (?, ?, ?, ?, ?)
  `);
  const insertChunk = sqlite.stmt(`
    INSERT OR IGNORE INTO chunks (id, doc_id, title, source, text, embedding) VALUES (?, ?, ?, ?, ?, ?)
  `);

  let imported = 0;
  let chunksImported = 0;
  sqlite.transaction(() => {
    for (const d of documents) {
      imported += insertDoc.run(
        d.id, d.title || 'Untitled', d.source || 'manual',
        d.chunkCount ?? 0, d.createdAt || new Date().toISOString()
      ).changes;
    }
    for (const c of chunks) {
      chunksImported += insertChunk.run(
        c.id, c.docId, c.title || null, c.source || null,
        c.text || '', sqlite.packEmbedding(c.embedding)
      ).changes;
    }
  })();

  return { total: documents.length, imported, chunks: chunksImported };
}

function migrateCache(dryRun) {
  const rows = readJson('storage/cache.json', { entries: [] }).entries || [];
  if (dryRun) return { total: rows.length, imported: 0 };

  const exists = sqlite.stmt('SELECT 1 FROM cache WHERE question = ? AND created_at = ?');
  const insert = sqlite.stmt(`
    INSERT INTO cache (question, answer, origin, sources, embedding, created_at, last_used, hits)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `);

  let imported = 0;
  sqlite.transaction(() => {
    for (const e of rows) {
      const createdAt = Number(e.createdAt) || Date.now();
      if (exists.get(e.question, createdAt)) continue;
      insert.run(
        e.question, e.answer, e.origin || null,
        JSON.stringify(e.sources || []),
        sqlite.packEmbedding(e.embedding),
        createdAt, Number(e.lastUsed) || createdAt, Number(e.hits) || 0
      );
      imported += 1;
    }
  })();

  return { total: rows.length, imported };
}

/**
 * The two log workbooks held real history before the switch. Without importing
 * them the Benchmark view would go blank, which looks exactly like data loss.
 *
 * Header names are matched rather than column positions, so a workbook written
 * by an older column order still imports correctly.
 */
async function migrateWorkbook({ file, table, dryRun, map }) {
  const ExcelJS = require('exceljs');
  const target = path.resolve(PROJECT_ROOT, file);
  if (!fs.existsSync(target)) return { total: 0, imported: 0 };

  const workbook = new ExcelJS.Workbook();
  try {
    await workbook.xlsx.readFile(target);
  } catch (error) {
    console.warn(`  ${file}: ${error.message}`);
    return { total: 0, imported: 0 };
  }

  const rows = [];
  for (const sheet of workbook.worksheets) {
    const headers = sheet.getRow(1).values.slice(1).map((v) => String(v ?? '').trim());
    sheet.eachRow({ includeEmpty: false }, (row, index) => {
      if (index === 1) return;
      const cells = {};
      headers.forEach((h, i) => { cells[h] = row.getCell(i + 1).value; });
      rows.push(cells);
    });
  }

  if (dryRun) return { total: rows.length, imported: 0 };

  // Re-importing must not duplicate: a row is identified by its timestamp plus
  // its text field, which together are unique in practice.
  const { sql, params, dedupe, dedupeParams } = map;
  const insert = sqlite.stmt(sql);
  const exists = sqlite.stmt(dedupe);

  let imported = 0;
  sqlite.transaction(() => {
    for (const cells of rows) {
      const values = params(cells);
      if (!values) continue;
      if (exists.get(...dedupeParams(cells))) continue;
      insert.run(...values);
      imported += 1;
    }
  })();

  return { total: rows.length, imported };
}

function isoFrom(dateCell, timeCell) {
  const date = String(dateCell ?? '').trim().slice(0, 10);
  const time = String(timeCell ?? '00:00:00').trim().slice(0, 8);
  const parsed = new Date(`${date}T${time}`);
  return Number.isFinite(parsed.getTime()) ? parsed.toISOString() : new Date().toISOString();
}

const num = (v) => {
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
};

async function run({ dryRun = false } = {}) {
  sqlite.connect();

  const results = {
    chatLogs: migrateChatLogs(dryRun),
    files: migrateFiles(dryRun),
    knowledge: migrateKnowledge(dryRun),
    cache: migrateCache(dryRun)
  };

  results.requestLogs = await migrateWorkbook({
    file: 'logs/AssistantLogs.xlsx',
    dryRun,
    map: {
      sql: `INSERT INTO request_logs (at, user, question, origin, confidence, response_ms, model, answer, sources)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      dedupe: 'SELECT 1 FROM request_logs WHERE at = ? AND question = ?',
      dedupeParams: (c) => [isoFrom(c.Date, c.Time), String(c.Question ?? '')],
      params: (c) => {
        const at = isoFrom(c.Date, c.Time);
        const seconds = num(c['Response Time (s)']);
        return [
          at,
          String(c.User ?? 'web'),
          String(c.Question ?? ''),
          String(c.Origin ?? '') || null,
          num(c.Confidence),
          seconds != null ? Math.round(seconds * 1000) : null,
          String(c.Model ?? '') || null,
          String(c.Answer ?? ''),
          c.Sources ? JSON.stringify(String(c.Sources).split(' | ').filter(Boolean).map((t) => ({ title: t }))) : null
        ];
      }
    }
  });

  results.voiceLogs = await migrateWorkbook({
    file: 'logs/VoiceLogs.xlsx',
    dryRun,
    map: {
      sql: `INSERT INTO voice_logs (at, session_id, language, transcript, origin, confidence,
                                    response_ms, answer, spoken, interrupted)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      dedupe: 'SELECT 1 FROM voice_logs WHERE at = ? AND transcript = ?',
      dedupeParams: (c) => [isoFrom(c.Date, c.Time), String(c.Transcript ?? '')],
      params: (c) => {
        const at = isoFrom(c.Date, c.Time);
        const seconds = num(c['Response Time (s)']);
        return [
          at,
          String(c.Session ?? '') || null,
          String(c.Language ?? '') || null,
          String(c.Transcript ?? ''),
          String(c.Origin ?? '') || null,
          num(c.Confidence),
          seconds != null ? Math.round(seconds * 1000) : null,
          String(c.Answer ?? ''),
          String(c.Spoken ?? '').toLowerCase() === 'yes' ? 1 : 0,
          String(c.Interrupted ?? '').toLowerCase() === 'yes' ? 1 : 0
        ];
      }
    }
  });

  if (!dryRun) sqlite.connect().exec('VACUUM');
  return results;
}

module.exports = { run };

if (require.main === module) {
  const dryRun = process.argv.includes('--check');
  console.log(dryRun ? 'Checking what would be imported…\n' : 'Importing JSON stores into SQLite…\n');

  const line = (name, x) =>
    console.log(`  ${name.padEnd(12)} ${String(x.total).padStart(5)} found` +
      (dryRun ? '' : ` → ${x.imported} imported${x.chunks != null ? `, ${x.chunks} chunks` : ''}`));

  run({ dryRun })
    .then((r) => {
      line('chat logs', r.chatLogs);
      line('files', r.files);
      line('knowledge', r.knowledge);
      line('cache', r.cache);
      line('request log', r.requestLogs);
      line('voice log', r.voiceLogs);

      if (!dryRun) {
        // Fold the WAL back into the main file first, or the size reported
        // here is just the header and looks like nothing was written.
        sqlite.connect().pragma('wal_checkpoint(TRUNCATE)');
        const bytes = fs.statSync(sqlite.DB_FILE).size;
        console.log(`\n  ${sqlite.DB_FILE}`);
        console.log(`  ${(bytes / 1024).toFixed(0)} KB`);
        console.log('\n  The JSON files and workbooks were not modified.');
      }
      sqlite.close();
    })
    .catch((error) => {
      console.error(error);
      process.exit(1);
    });
}
