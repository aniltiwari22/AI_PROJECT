const path = require('path');
const fsp = require('fs/promises');
const ExcelJS = require('exceljs');
const sqlite = require('../storage/sqlite');

/**
 * Voice turns are logged separately: they carry fields chat does not
 * (language, transcript, whether the reply was spoken or interrupted) and
 * folding them into the request log would leave most columns blank per row.
 *
 * Same arrangement as the request log — SQLite is the store, the workbook is
 * produced on demand by exportWorkbook().
 */

const PROJECT_ROOT = path.resolve(__dirname, '../../..');
const LOG_FILE = process.env.VOICE_LOG_XLSX
  ? path.resolve(PROJECT_ROOT, process.env.VOICE_LOG_XLSX)
  : path.resolve(PROJECT_ROOT, 'logs/VoiceLogs.xlsx');

const ENABLED = process.env.VOICE_LOGGING !== 'false';

const COLUMNS = [
  { header: 'Date', width: 12, key: 'date' },
  { header: 'Time', width: 10, key: 'time' },
  { header: 'Session', width: 16, key: 'session' },
  { header: 'Language', width: 10, key: 'language' },
  { header: 'Transcript', width: 46, key: 'transcript' },
  { header: 'Origin', width: 12, key: 'origin' },
  { header: 'Confidence', width: 12, key: 'confidence' },
  { header: 'Response Time (s)', width: 17, key: 'seconds' },
  { header: 'Spoken', width: 9, key: 'spoken' },
  { header: 'Interrupted', width: 12, key: 'interrupted' },
  { header: 'Answer', width: 70, key: 'answer' }
];

function log(entry) {
  if (!ENABLED) return;

  try {
    sqlite
      .stmt(`INSERT INTO voice_logs
               (at, session_id, language, transcript, origin, confidence, response_ms,
                answer, spoken, interrupted)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(
        new Date().toISOString(),
        entry.sessionId || null,
        entry.language || null,
        String(entry.transcript ?? ''),
        entry.origin || null,
        typeof entry.confidence === 'number' ? entry.confidence : null,
        entry.responseMs ?? null,
        String(entry.answer ?? ''),
        entry.spoken ? 1 : 0,
        entry.interrupted ? 1 : 0
      );
  } catch (error) {
    console.warn(`Voice log write failed: ${error.message}`);
  }
}

async function flush() {}

async function stats() {
  const row = sqlite
    .stmt(`SELECT COUNT(*) AS total, COUNT(DISTINCT session_id) AS sessions,
                  MIN(at) AS first, MAX(at) AS last FROM voice_logs`)
    .get();

  const languages = sqlite
    .stmt(`SELECT language, COUNT(*) AS turns FROM voice_logs
           WHERE language IS NOT NULL GROUP BY language ORDER BY turns DESC`)
    .all();

  return {
    file: LOG_FILE,
    engine: 'sqlite',
    enabled: ENABLED,
    totalRows: row.total,
    sessions: row.sessions,
    firstAt: row.first,
    lastAt: row.last,
    languages,
    pending: 0
  };
}

async function exportWorkbook(target = LOG_FILE) {
  const rows = sqlite
    .stmt(`SELECT at, session_id, language, transcript, origin, confidence,
                  response_ms, answer, spoken, interrupted
           FROM voice_logs ORDER BY at ASC`)
    .all();

  const workbook = new ExcelJS.Workbook();
  const sheet = workbook.addWorksheet('Voice');
  sheet.columns = COLUMNS.map((c) => ({ header: c.header, width: c.width, key: c.key }));
  sheet.getRow(1).font = { bold: true };

  for (const row of rows) {
    const at = new Date(row.at);
    sheet.addRow({
      date: at.toISOString().slice(0, 10),
      time: at.toTimeString().slice(0, 8),
      session: row.session_id || '',
      language: row.language || '',
      transcript: row.transcript || '',
      origin: row.origin || '',
      confidence: typeof row.confidence === 'number' ? row.confidence : '',
      seconds: Number(((row.response_ms || 0) / 1000).toFixed(2)),
      spoken: row.spoken ? 'yes' : 'no',
      interrupted: row.interrupted ? 'yes' : 'no',
      answer: String(row.answer || '').slice(0, 2000)
    });
  }

  await fsp.mkdir(path.dirname(target), { recursive: true });
  await workbook.xlsx.writeFile(target);

  return { file: target, rows: rows.length };
}

module.exports = { log, flush, stats, exportWorkbook, LOG_FILE, COLUMNS };
