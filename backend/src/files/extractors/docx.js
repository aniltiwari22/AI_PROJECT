const zlib = require('zlib');

// DOCX/XLSX/PPTX are ZIP archives. No unzip library is installable here, so
// this reads the ZIP central directory directly and inflates the one entry we
// need with the built-in zlib.

const EOCD_SIG = 0x06054b50;
const CEN_SIG = 0x02014b50;

function findEndOfCentralDirectory(buffer) {
  // The EOCD is at the end, but a trailing comment can push it back up to 64KB.
  const minPos = Math.max(0, buffer.length - 65557);
  for (let i = buffer.length - 22; i >= minPos; i -= 1) {
    if (buffer.readUInt32LE(i) === EOCD_SIG) return i;
  }
  return -1;
}

function readEntries(buffer) {
  const eocd = findEndOfCentralDirectory(buffer);
  if (eocd === -1) return [];

  const count = buffer.readUInt16LE(eocd + 10);
  let pointer = buffer.readUInt32LE(eocd + 16);
  const entries = [];

  for (let i = 0; i < count && pointer + 46 <= buffer.length; i += 1) {
    if (buffer.readUInt32LE(pointer) !== CEN_SIG) break;

    const nameLength = buffer.readUInt16LE(pointer + 28);
    const extraLength = buffer.readUInt16LE(pointer + 30);
    const commentLength = buffer.readUInt16LE(pointer + 32);

    entries.push({
      name: buffer.subarray(pointer + 46, pointer + 46 + nameLength).toString('utf8'),
      method: buffer.readUInt16LE(pointer + 10),
      compressedSize: buffer.readUInt32LE(pointer + 20),
      localHeaderOffset: buffer.readUInt32LE(pointer + 42)
    });

    pointer += 46 + nameLength + extraLength + commentLength;
  }

  return entries;
}

function readEntryData(buffer, entry) {
  const local = entry.localHeaderOffset;
  // Local header name/extra lengths differ from the central ones, so re-read.
  const nameLength = buffer.readUInt16LE(local + 26);
  const extraLength = buffer.readUInt16LE(local + 28);
  const start = local + 30 + nameLength + extraLength;
  const raw = buffer.subarray(start, start + entry.compressedSize);

  if (entry.method === 0) return raw;
  try {
    return zlib.inflateRawSync(raw);
  } catch {
    return null;
  }
}

function decodeEntities(text) {
  return text
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&#(\d+);/g, (m, d) => String.fromCharCode(Number(d)))
    .replace(/&amp;/g, '&');
}

function xmlToText(xml) {
  return decodeEntities(
    xml
      .replace(/<w:tab\b[^>]*\/>/g, '\t')
      .replace(/<w:br\b[^>]*\/>/g, '\n')
      .replace(/<\/w:p>/g, '\n')
      .replace(/<\/a:p>/g, '\n')
      .replace(/<[^>]+>/g, '')
  )
    .replace(/\r\n?/g, '\n')
    .split('\n')
    .map((line) => line.replace(/[ \t]+/g, ' ').trim())
    .filter(Boolean)
    .join('\n')
    .trim();
}

/**
 * Extracts text from a DOCX (and, best-effort, PPTX) buffer.
 * @returns {{ text: string, warning?: string }}
 */
function extractDocxText(buffer) {
  if (buffer.readUInt32LE(0) !== 0x04034b50) {
    const error = new Error('Not a valid DOCX file (missing ZIP signature)');
    error.statusCode = 400;
    throw error;
  }

  const entries = readEntries(buffer);
  if (!entries.length) {
    return { text: '', warning: 'Could not read the document archive.' };
  }

  // Main body first, then any headers/footers and slide bodies.
  const wanted = entries.filter(
    (e) =>
      e.name === 'word/document.xml' ||
      /^word\/(header|footer)\d*\.xml$/.test(e.name) ||
      /^ppt\/slides\/slide\d+\.xml$/.test(e.name)
  );

  if (!wanted.length) {
    return {
      text: '',
      warning: 'No document body found. Legacy .doc files are not supported — save as .docx.'
    };
  }

  wanted.sort((a, b) => (a.name === 'word/document.xml' ? -1 : b.name === 'word/document.xml' ? 1 : 0));

  let combined = '';
  for (const entry of wanted) {
    const data = readEntryData(buffer, entry);
    if (data) combined += `${xmlToText(data.toString('utf8'))}\n`;
  }

  const text = combined.trim();
  return text ? { text } : { text: '', warning: 'The document appears to contain no text.' };
}

module.exports = { extractDocxText };
