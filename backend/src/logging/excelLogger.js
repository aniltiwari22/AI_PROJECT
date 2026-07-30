const path = require('path');
const fsp = require('fs/promises');
const ExcelJS = require('exceljs');
const sqlite = require('../storage/sqlite');

/**
 * Per-request logging.
 *
 * Rows go into SQLite and the workbook is generated on demand. Previously
 * every request appended to AssistantLogs.xlsx, which meant loading, mutating
 * and rewriting the entire workbook on a batch timer — slower than some cached
 * answers, and any rows still sitting in the batch were lost if the process
 * died. Analytics then had to parse the whole file back to answer a question
 * as simple as "what was the median response time".
 *
 * The spreadsheet has not gone away: exportWorkbook() writes it, one sheet per
 * month, exactly as before. The app just no longer holds it open for writing.
 */

const PROJECT_ROOT = path.resolve(__dirname, '../../..');
const LOG_FILE = process.env.LOG_XLSX
  ? path.resolve(PROJECT_ROOT, process.env.LOG_XLSX)
  : path.resolve(PROJECT_ROOT, 'logs/AssistantLogs.xlsx');

const ENABLED = process.env.EXCEL_LOGGING !== 'false';

const COLUMNS = [
  { header: 'Date', width: 12, key: 'date' },
  { header: 'Time', width: 10, key: 'time' },
  { header: 'User', width: 14, key: 'user' },
  { header: 'Question', width: 52, key: 'question' },
  { header: 'Origin', width: 12, key: 'origin' },
  { header: 'Confidence', width: 12, key: 'confidence' },
  { header: 'Response Time (s)', width: 17, key: 'seconds' },
  { header: 'Model', width: 20, key: 'model' },
  { header: 'Answer Chars', width: 13, key: 'chars' },
  { header: 'Sources', width: 40, key: 'sources' },
  { header: 'Answer', width: 80, key: 'answer' }
];

function monthSheetName(date) {
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}`;
}

/**
 * A single INSERT, measured in microseconds, so there is no batching timer and
 * nothing buffered that a crash could lose.
 */
function log(entry) {
  if (!ENABLED) return;

  try {
    sqlite
      .stmt(`INSERT INTO request_logs
               (at, user, question, origin, confidence, response_ms, model, answer, sources)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(
        new Date().toISOString(),
        entry.user || 'web',
        String(entry.question ?? ''),
        entry.origin || null,
        typeof entry.confidence === 'number' ? entry.confidence : null,
        entry.responseMs ?? null,
        entry.model || null,
        String(entry.answer ?? ''),
        entry.sources ? JSON.stringify(entry.sources) : null
      );
  } catch (error) {
    // Logging must never take a request down with it.
    console.warn(`Request log write failed: ${error.message}`);
  }
}

// Writes are synchronous now. Kept so callers that awaited the batch flush
// continue to work unchanged.
async function flush() {}

async function stats() {
  const row = sqlite
    .stmt('SELECT COUNT(*) AS total, MIN(at) AS first, MAX(at) AS last FROM request_logs')
    .get();

  const months = sqlite
    .stmt(`SELECT substr(at, 1, 7) AS name, COUNT(*) AS rows
           FROM request_logs GROUP BY name ORDER BY name`)
    .all();

  return {
    file: LOG_FILE,
    engine: 'sqlite',
    enabled: ENABLED,
    totalRows: row.total,
    firstAt: row.first,
    lastAt: row.last,
    sheets: months,
    pending: 0
  };
}

/** Writes the workbook from the database, one sheet per month. */
async function exportWorkbook(target = LOG_FILE) {
  const rows = sqlite
    .stmt(`SELECT at, user, question, origin, confidence, response_ms, model, answer, sources
           FROM request_logs ORDER BY at ASC`)
    .all();

  const workbook = new ExcelJS.Workbook();
  const sheets = new Map();
  const header = () => COLUMNS.map((c) => ({ header: c.header, width: c.width, key: c.key }));

  for (const row of rows) {
    const at = new Date(row.at);
    const name = monthSheetName(at);

    let sheet = sheets.get(name);
    if (!sheet) {
      sheet = workbook.addWorksheet(name);
      sheet.columns = header();
      sheet.getRow(1).font = { bold: true };
      sheets.set(name, sheet);
    }

    const sources = row.sources ? JSON.parse(row.sources) : [];
    sheet.addRow({
      date: at.toISOString().slice(0, 10),
      time: at.toTimeString().slice(0, 8),
      user: row.user || '',
      question: row.question || '',
      origin: row.origin || '',
      confidence: typeof row.confidence === 'number' ? row.confidence : '',
      seconds: Number(((row.response_ms || 0) / 1000).toFixed(2)),
      model: row.model || '',
      chars: String(row.answer || '').length,
      sources: Array.isArray(sources) ? sources.map((s) => s.title || s.reference || '').join(' | ') : '',
      answer: String(row.answer || '').slice(0, 2000)
    });
  }

  // ExcelJS refuses to write a workbook with no sheets.
  if (!sheets.size) workbook.addWorksheet(monthSheetName(new Date())).columns = header();

  await fsp.mkdir(path.dirname(target), { recursive: true });
  await workbook.xlsx.writeFile(target);

  return { file: target, rows: rows.length, sheets: Math.max(sheets.size, 1) };
}

module.exports = { log, flush, stats, monthSheetName, exportWorkbook, LOG_FILE, COLUMNS };
