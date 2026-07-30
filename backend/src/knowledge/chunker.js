/**
 * Splitting text for retrieval.
 *
 * Prose and code need different treatment. The word-based splitter used for
 * everything flattened code onto one line — it split on /\s+/ and rejoined
 * with single spaces, so every newline and every indent was destroyed before
 * the text was ever embedded:
 *
 *   function pack(v) { if (!Array.isArray(v)) return null; return Buffer... }
 *
 * That is what the model saw, and what it quoted back. It also cut through the
 * middle of functions: two of five chunks from a real 183-line file came out
 * with unbalanced braces.
 *
 * Code is therefore split on declaration boundaries, keeps its formatting, and
 * carries the line range it came from so a citation can say "db.js:14-22".
 */

const CODE_EXTENSIONS = new Set([
  'js', 'jsx', 'mjs', 'cjs', 'ts', 'tsx', 'py', 'java', 'kt', 'go', 'rs',
  'c', 'h', 'cpp', 'hpp', 'cc', 'cs', 'rb', 'php', 'swift', 'scala',
  'sql', 'sh', 'bash', 'ps1', 'css', 'scss', 'less', 'vue', 'svelte'
]);

// A line at column zero that begins a new top-level unit. Deliberately broad
// and language-agnostic: over-splitting costs a little retrieval precision,
// while under-splitting produces the mid-function cuts this exists to prevent.
const DECLARATION = new RegExp(
  '^(?:' +
    '(?:export\\s+)?(?:default\\s+)?(?:async\\s+)?(?:function|class|const|let|var)\\b' +
    '|(?:public|private|protected|internal|static|final)\\s' +
    '|(?:def|class|async def)\\s' +          // Python
    '|(?:func|type|package|import)\\s' +      // Go
    '|(?:fn|impl|struct|enum|trait|pub)\\s' + // Rust
    '|(?:interface|enum|namespace|declare|type)\\s' +
    '|(?:CREATE|INSERT|UPDATE|DELETE|SELECT|ALTER|DROP)\\s' + // SQL
    '|@\\w+' +                                // decorators / annotations
    '|[\\w.$]+\\s*[:=]\\s*(?:async\\s*)?(?:function|\\()' + // obj methods, arrows
    '|module\\.exports\\b' +
  ')'
);

function extensionOf(name = '') {
  const match = String(name).toLowerCase().match(/\.([a-z0-9]+)$/);
  return match ? match[1] : '';
}

function looksLikeCode(filename, text) {
  if (CODE_EXTENSIONS.has(extensionOf(filename))) return true;

  // No usable filename — judge the text. Code is dense in punctuation that
  // prose almost never uses, and its lines are mostly short.
  const sample = String(text || '').slice(0, 4000);
  if (!sample.trim()) return false;

  const lines = sample.split('\n');
  if (lines.length < 5) return false;

  const structural = (sample.match(/[{};()[\]=<>]/g) || []).length;
  const indented = lines.filter((l) => /^[ \t]{2,}\S/.test(l)).length;

  return structural / sample.length > 0.04 && indented / lines.length > 0.15;
}

/**
 * Groups lines into top-level units — a function, class or statement block
 * together with the comments immediately above it, which is where the intent
 * usually is.
 */
function splitIntoUnits(lines) {
  const units = [];
  let current = null;

  const startUnit = (index) => {
    current = { startLine: index + 1, lines: [] };
    units.push(current);
  };

  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i];
    const atTopLevel = /^\S/.test(line);
    const startsUnit = atTopLevel && DECLARATION.test(line);

    if (!current) {
      startUnit(i);
    } else if (startsUnit) {
      // A comment block directly above a declaration belongs with it, so walk
      // back over trailing comment lines and move them into the new unit.
      const trailing = [];
      while (current.lines.length) {
        const last = current.lines[current.lines.length - 1];
        if (/^\s*(?:\/\/|#|\*|\/\*)/.test(last) || !last.trim()) {
          trailing.unshift(current.lines.pop());
        } else {
          break;
        }
      }
      if (!current.lines.length) units.pop();

      startUnit(i - trailing.length);
      current.lines.push(...trailing);
    }

    current.lines.push(line);
  }

  return units
    .filter((u) => u.lines.join('').trim())
    .map((u) => ({ ...u, endLine: u.startLine + u.lines.length - 1 }));
}

/** Splits one oversized unit on line boundaries — never mid-line. */
function splitLongUnit(unit, budget) {
  const out = [];
  let buffer = [];
  let start = unit.startLine;
  let size = 0;

  for (let i = 0; i < unit.lines.length; i += 1) {
    const line = unit.lines[i];

    if (size + line.length > budget && buffer.length) {
      out.push({ startLine: start, endLine: start + buffer.length - 1, lines: buffer });
      start += buffer.length;
      buffer = [];
      size = 0;
    }

    buffer.push(line);
    size += line.length + 1;
  }

  if (buffer.length) out.push({ startLine: start, endLine: start + buffer.length - 1, lines: buffer });
  return out;
}

/**
 * @returns {Array<{text:string, startLine:number, endLine:number}>}
 */
function chunkCode(text, { budget = 1400 } = {}) {
  const lines = String(text || '').replace(/\r\n/g, '\n').split('\n');
  if (!lines.join('').trim()) return [];

  const units = splitIntoUnits(lines).flatMap((u) =>
    u.lines.join('\n').length > budget ? splitLongUnit(u, budget) : [u]
  );

  // Pack consecutive units together up to the budget so a file of one-line
  // exports does not become one chunk per line.
  const chunks = [];
  let batch = null;

  for (const unit of units) {
    const body = unit.lines.join('\n');

    if (batch && batch.size + body.length + 1 <= budget) {
      batch.parts.push(body);
      batch.endLine = unit.endLine;
      batch.size += body.length + 1;
      continue;
    }

    batch = { startLine: unit.startLine, endLine: unit.endLine, parts: [body], size: body.length };
    chunks.push(batch);
  }

  return chunks.map((c) => ({
    text: c.parts.join('\n'),
    startLine: c.startLine,
    endLine: c.endLine
  }));
}

/** Word-window splitting, unchanged — correct for prose, wrong for code. */
function chunkProse(text, { words = 180, overlap = 30 } = {}) {
  const allWords = String(text || '').split(/\s+/).filter(Boolean);
  if (!allWords.length) return [];

  const step = Math.max(1, words - overlap);
  const chunks = [];

  for (let i = 0; i < allWords.length; i += step) {
    const slice = allWords.slice(i, i + words);
    if (slice.length) chunks.push({ text: slice.join(' '), startLine: null, endLine: null });
    if (i + words >= allWords.length) break;
  }

  return chunks;
}

function chunk(text, { filename = '', codeBudget, words, overlap } = {}) {
  return looksLikeCode(filename, text)
    ? chunkCode(text, { budget: codeBudget })
    : chunkProse(text, { words, overlap });
}

module.exports = { chunk, chunkCode, chunkProse, looksLikeCode, splitIntoUnits, CODE_EXTENSIONS };
