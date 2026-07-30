const { generateEmbedding, embeddingStatus } = require('../config/ollama');
const sqlite = require('../storage/sqlite');
const chunker = require('./chunker');

const CHUNK_WORDS = Number(process.env.KNOWLEDGE_CHUNK_WORDS || 180);
const CHUNK_OVERLAP = Number(process.env.KNOWLEDGE_CHUNK_OVERLAP || 30);
const CODE_CHUNK_CHARS = Number(process.env.KNOWLEDGE_CODE_CHUNK_CHARS || 1400);

// Kept as a plain string[] because the tests and chatEngine use it that way.
// Ingestion goes through chunker.chunk() directly, which also returns the line
// range each chunk came from.
function chunkText(text) {
  return chunker.chunkProse(text, { words: CHUNK_WORDS, overlap: CHUNK_OVERLAP }).map((c) => c.text);
}

function cosineSimilarity(a, b) {
  if (!a || !b || a.length !== b.length) return 0;

  let dot = 0;
  let normA = 0;
  let normB = 0;

  for (let i = 0; i < a.length; i += 1) {
    dot += a[i] * b[i];
    normA += a[i] * a[i];
    normB += b[i] * b[i];
  }

  if (!normA || !normB) return 0;
  return dot / (Math.sqrt(normA) * Math.sqrt(normB));
}

const STOP_WORDS = new Set([
  'the', 'a', 'an', 'is', 'are', 'was', 'were', 'of', 'to', 'in', 'on', 'for',
  'and', 'or', 'what', 'how', 'why', 'when', 'who', 'it', 'this', 'that', 'do',
  'does', 'did', 'can', 'i', 'you', 'me', 'my', 'be', 'with', 'about'
]);

function tokenize(text) {
  return String(text || '')
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((t) => t.length > 2 && !STOP_WORDS.has(t));
}

// Fallback scoring when embeddings are unavailable: fraction of the query's
// meaningful terms that appear in the chunk. Still exported and still used by
// chatEngine to pick relevant passages out of a long uploaded document, which
// is plain text in memory rather than anything indexed.
function lexicalScore(queryTokens, chunkText) {
  if (!queryTokens.length) return 0;
  const haystack = ` ${String(chunkText).toLowerCase()} `;
  const hits = queryTokens.filter((token) => haystack.includes(token)).length;
  return hits / queryTokens.length;
}

/**
 * What gets embedded for a chunk: the file path, split into words, followed by
 * the chunk itself. "knowledge/semanticCache.js" becomes "knowledge semantic
 * Cache js", so a question about "the semantic cache" has something to match.
 */
function embeddingTextFor(label, text) {
  const words = String(label)
    .replace(/[/\\_.-]+/g, ' ')
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .trim();

  return words ? `${words}\n\n${text}` : text;
}

async function addDocument({ title, source, text }) {
  // Must be a real string. A number or object used to pass through String(),
  // so `{"text": 999}` created a document reading "999" and an object became
  // "[object Object]" — indexed, embedded, and retrievable as nonsense.
  if (typeof text !== 'string' || !text.trim()) {
    const error = new Error('Document text is required and must be a string');
    error.statusCode = 400;
    throw error;
  }

  const body = text.trim();
  // Labels are shown in the UI and written into source citations, so a stray
  // object here would render as "[object Object]" next to the answer.
  const label = typeof title === 'string' && title.trim() ? title.trim() : 'Untitled';
  const origin = typeof source === 'string' && source.trim() ? source.trim() : 'manual';

  // The title is usually a filename, which is what tells the chunker whether
  // this is code — and code must keep its newlines and line numbers.
  const pieces = chunker.chunk(body, {
    filename: label,
    codeBudget: CODE_CHUNK_CHARS,
    words: CHUNK_WORDS,
    overlap: CHUNK_OVERLAP
  });

  const docId = `doc_${Date.now()}_${Math.round(Math.random() * 1e6)}`;

  // The embedded string is not the stored one. Questions name paths and
  // concepts ("the semantic cache eviction") while a code body contains
  // neither — identifiers are split across camelCase and the words live in the
  // file path. Prefixing the path gives the vector a lexical anchor; the stored
  // text stays clean so nothing synthetic is ever shown or sent to the model.
  const embedded = await Promise.all(
    pieces.map(async (piece, index) => ({
      id: `${docId}_c${index}`,
      text: piece.text,
      startLine: piece.startLine,
      endLine: piece.endLine,
      embedding: await generateEmbedding(embeddingTextFor(label, piece.text))
    }))
  );

  // One transaction: either the document and all its chunks land, or none do.
  // The JSON version could half-write a document if the process died mid-save.
  const insertDoc = sqlite.stmt(
    'INSERT INTO documents (id, title, source, chunk_count, created_at) VALUES (?, ?, ?, ?, ?)'
  );
  const insertChunk = sqlite.stmt(
    `INSERT INTO chunks (id, doc_id, title, source, text, embedding, start_line, end_line)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
  );

  sqlite.transaction(() => {
    insertDoc.run(docId, label, origin, embedded.length, new Date().toISOString());
    for (const chunk of embedded) {
      insertChunk.run(
        chunk.id, docId, label, origin, chunk.text,
        sqlite.packEmbedding(chunk.embedding),
        chunk.startLine ?? null, chunk.endLine ?? null
      );
    }
  })();

  return { id: docId, chunks: embedded.length, embedded: embedded.some((c) => c.embedding) };
}

async function listDocuments() {
  return sqlite
    .stmt(`SELECT id, title, source, chunk_count AS chunkCount, created_at AS createdAt
           FROM documents ORDER BY created_at ASC`)
    .all();
}

async function deleteDocument(docId) {
  // chunks cascade via the foreign key, and the FTS triggers follow.
  const result = sqlite.stmt('DELETE FROM documents WHERE id = ?').run(docId);
  return { deleted: result.changes > 0 };
}

// FTS5 needs a query, not a sentence: bare punctuation and operators are
// syntax errors, so the query is reduced to quoted terms OR'd together.
function toMatchQuery(tokens) {
  return tokens.map((t) => `"${t.replace(/"/g, '')}"`).join(' OR ');
}

/**
 * Returns the best-matching chunks with a normalised 0..1 relevance score.
 * `mode` tells the caller whether scores came from embeddings or keywords,
 * since the two are not directly comparable.
 */
async function search(query, topK = 4) {
  const { n } = sqlite.stmt('SELECT COUNT(*) AS n FROM chunks').get();
  if (!n) return { matches: [], mode: 'empty' };

  const queryVector = await generateEmbedding(query);

  if (queryVector) {
    const rows = sqlite
      .stmt(`SELECT id, doc_id AS docId, title, source, text, embedding,
                    start_line AS startLine, end_line AS endLine
             FROM chunks WHERE embedding IS NOT NULL`)
      .all();

    if (rows.length) {
      const scored = rows
        .map((row) => ({
          id: row.id,
          docId: row.docId,
          title: row.title,
          source: row.source,
          text: row.text,
          startLine: row.startLine,
          endLine: row.endLine,
          score: cosineSimilarity(queryVector, sqlite.unpackEmbedding(row.embedding))
        }))
        .sort((a, b) => b.score - a.score);

      return { matches: scored.slice(0, topK), mode: 'embedding' };
    }
  }

  // Embeddings unavailable — fall back to SQLite's own full-text index rather
  // than scoring every chunk in JavaScript.
  const tokens = tokenize(query);
  if (!tokens.length) return { matches: [], mode: 'lexical' };

  const rows = sqlite
    .stmt(`SELECT c.id, c.doc_id AS docId, c.title, c.source, c.text,
                  c.start_line AS startLine, c.end_line AS endLine, bm25(chunks_fts) AS rank
           FROM chunks_fts JOIN chunks c ON c.rowid = chunks_fts.rowid
           WHERE chunks_fts MATCH ? ORDER BY rank LIMIT ?`)
    .all(toMatchQuery(tokens), topK);

  // bm25 returns negative numbers where more negative is better. The rest of
  // the pipeline expects 0..1 with higher meaning better, so recompute the
  // same term-overlap fraction the old scorer used and keep thresholds valid.
  const matches = rows.map((row) => ({
    id: row.id,
    docId: row.docId,
    title: row.title,
    source: row.source,
    text: row.text,
    startLine: row.startLine,
    endLine: row.endLine,
    score: lexicalScore(tokens, row.text)
  }));

  return { matches, mode: 'lexical' };
}

async function stats() {
  const docs = sqlite.stmt('SELECT COUNT(*) AS n FROM documents').get().n;
  const chunks = sqlite.stmt('SELECT COUNT(*) AS n FROM chunks').get().n;

  return {
    documents: docs,
    chunks,
    embeddings: embeddingStatus(),
    file: sqlite.DB_FILE
  };
}

module.exports = {
  addDocument,
  listDocuments,
  deleteDocument,
  search,
  stats,
  // exported for tests
  chunkText,
  cosineSimilarity,
  lexicalScore,
  tokenize
};
