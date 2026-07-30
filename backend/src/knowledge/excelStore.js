const fs = require('fs/promises');
const fsSync = require('fs');
const path = require('path');
const ExcelJS = require('exceljs');

/**
 * Structured knowledge held in an Excel workbook. This is the fastest source in
 * the pipeline: a hit is answered directly from the sheet with no LLM call, so
 * curated answers (error codes, API paths, SQL) return in milliseconds instead
 * of the ~35s a generated reply costs on this hardware.
 */

const PROJECT_ROOT = path.resolve(__dirname, '../../..');
const WORKBOOK = process.env.KNOWLEDGE_XLSX
  ? path.resolve(PROJECT_ROOT, process.env.KNOWLEDGE_XLSX)
  : path.resolve(PROJECT_ROOT, 'storage/knowledge.xlsx');

// Each sheet is a lookup table. `key` columns are matched against the question;
// the remaining columns are returned as the answer.
const SHEETS = [
  { name: 'FAQs', columns: ['Question', 'Answer', 'Tags'], keys: ['Question', 'Tags'] },
  { name: 'APIs', columns: ['Name', 'Endpoint', 'Method', 'Description', 'Notes'], keys: ['Name', 'Endpoint', 'Description'] },
  { name: 'Errors', columns: ['Code', 'Message', 'Reason', 'Resolution'], keys: ['Code', 'Message', 'Reason'] },
  { name: 'SQL', columns: ['Name', 'Query', 'Description'], keys: ['Name', 'Description'] },
  { name: 'Jira', columns: ['Ticket', 'Problem', 'Solution'], keys: ['Ticket', 'Problem'] },
  { name: 'Emails', columns: ['Name', 'Subject', 'Body'], keys: ['Name', 'Subject'] }
];

const STOP = new Set([
  'the', 'a', 'an', 'is', 'are', 'was', 'of', 'to', 'in', 'on', 'for', 'and', 'or',
  'what', 'how', 'why', 'when', 'who', 'it', 'this', 'that', 'do', 'does', 'did',
  'can', 'i', 'you', 'me', 'my', 'be', 'with', 'about', 'please', 'tell', 'show', 'give'
]);

function tokenize(text) {
  return String(text || '')
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((t) => t && !STOP.has(t));
}

// Identifiers like "101804" or "SVC-42" are the strongest possible signal that
// a row is the right one, so they are matched separately from ordinary words.
function identifiers(text) {
  return (String(text || '').match(/\b[a-z]*\d[a-z0-9-]*\b/gi) || []).map((s) => s.toLowerCase());
}

let cache = { mtimeMs: 0, sheets: [] };

async function ensureWorkbook() {
  if (fsSync.existsSync(WORKBOOK)) return;

  await fs.mkdir(path.dirname(WORKBOOK), { recursive: true });
  const wb = new ExcelJS.Workbook();

  for (const sheet of SHEETS) {
    const ws = wb.addWorksheet(sheet.name);
    ws.addRow(sheet.columns);
    ws.getRow(1).font = { bold: true };
    ws.columns = sheet.columns.map(() => ({ width: 28 }));
    ws.views = [{ state: 'frozen', ySplit: 1 }];
  }

  await wb.xlsx.writeFile(WORKBOOK);
  console.log(`Created knowledge workbook: ${WORKBOOK}`);
}

// Cell values can be rich text or formula objects, not just strings.
function cellText(value) {
  if (value === null || value === undefined) return '';
  if (typeof value === 'object') {
    if (Array.isArray(value.richText)) return value.richText.map((r) => r.text).join('');
    if (value.text) return String(value.text);
    if (value.result !== undefined) return String(value.result);
    if (value instanceof Date) return value.toISOString().slice(0, 10);
    return '';
  }
  return String(value);
}

/** Reloads only when the file changed on disk, so lookups stay fast. */
async function load() {
  await ensureWorkbook();

  const stat = await fs.stat(WORKBOOK);
  if (stat.mtimeMs === cache.mtimeMs) return cache.sheets;

  const wb = new ExcelJS.Workbook();
  await wb.xlsx.readFile(WORKBOOK);

  const sheets = [];
  for (const ws of wb.worksheets) {
    const headerRow = ws.getRow(1);
    const headers = [];
    headerRow.eachCell({ includeEmpty: true }, (cell, col) => {
      headers[col - 1] = cellText(cell.value).trim();
    });
    if (!headers.filter(Boolean).length) continue;

    const config = SHEETS.find((s) => s.name.toLowerCase() === ws.name.toLowerCase());
    // Unknown sheets are still searchable; treat the first column as the key.
    const keyNames = config ? config.keys : [headers[0]];

    const rows = [];
    ws.eachRow({ includeEmpty: false }, (row, index) => {
      if (index === 1) return;
      const record = {};
      let hasValue = false;
      row.eachCell({ includeEmpty: true }, (cell, col) => {
        const header = headers[col - 1];
        if (!header) return;
        const text = cellText(cell.value).trim();
        record[header] = text;
        if (text) hasValue = true;
      });
      if (!hasValue) return;

      const keyText = keyNames.map((k) => record[k] || '').join(' ');
      rows.push({
        record,
        rowNumber: index,
        keyTokens: new Set(tokenize(keyText)),
        keyIds: new Set(identifiers(keyText)),
        // Fall back to the whole row so a term in any column can still match.
        allTokens: new Set(tokenize(Object.values(record).join(' ')))
      });
    });

    if (rows.length) sheets.push({ name: ws.name, headers: headers.filter(Boolean), rows });
  }

  cache = { mtimeMs: stat.mtimeMs, sheets };
  return sheets;
}

/**
 * Scores a row against the question.
 * An identifier match (error code, ticket id) is near-decisive; otherwise the
 * score is the fraction of the question's meaningful words found in the row.
 */
function scoreRow(row, qTokens, qIds) {
  if (qIds.length) {
    const hit = qIds.some((id) => row.keyIds.has(id));
    if (hit) return 1;
  }
  if (!qTokens.length) return 0;

  const keyHits = qTokens.filter((t) => row.keyTokens.has(t)).length;
  const anyHits = qTokens.filter((t) => row.allTokens.has(t)).length;

  // Weight key columns above incidental matches elsewhere in the row.
  return (keyHits / qTokens.length) * 0.8 + (anyHits / qTokens.length) * 0.2;
}

/**
 * @returns {Promise<{hit:boolean, confidence:number, sheet?:string, record?:object, rowNumber?:number}>}
 */
async function search(question, { threshold = Number(process.env.EXCEL_MATCH_THRESHOLD || 0.6) } = {}) {
  let sheets;
  try {
    sheets = await load();
  } catch (error) {
    console.warn(`Excel knowledge unavailable: ${error.message}`);
    return { hit: false, confidence: 0 };
  }

  const qTokens = tokenize(question);
  const qIds = identifiers(question);

  let best = null;
  for (const sheet of sheets) {
    for (const row of sheet.rows) {
      const score = scoreRow(row, qTokens, qIds);
      if (!best || score > best.confidence) {
        best = { confidence: score, sheet: sheet.name, record: row.record, rowNumber: row.rowNumber };
      }
    }
  }

  if (!best || best.confidence < threshold) {
    return { hit: false, confidence: best ? Number(best.confidence.toFixed(3)) : 0 };
  }

  return { hit: true, ...best, confidence: Number(best.confidence.toFixed(3)) };
}

/** Renders a matched row as the answer text shown to the user. */
function formatAnswer(match) {
  const lines = [];
  for (const [key, value] of Object.entries(match.record)) {
    if (!value) continue;
    lines.push(`**${key}:** ${value}`);
  }
  return lines.join('\n\n');
}

async function stats() {
  try {
    const sheets = await load();
    return {
      file: WORKBOOK,
      sheets: sheets.map((s) => ({ name: s.name, rows: s.rows.length })),
      totalRows: sheets.reduce((n, s) => n + s.rows.length, 0)
    };
  } catch (error) {
    return { file: WORKBOOK, error: error.message };
  }
}

module.exports = { search, formatAnswer, stats, ensureWorkbook, tokenize, identifiers, scoreRow, WORKBOOK, SHEETS };
