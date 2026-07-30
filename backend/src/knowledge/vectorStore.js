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
 * Reciprocal Rank Fusion.
 *
 * Cosine similarity runs 0..1 and BM25 is negative and unbounded, so the two
 * scores cannot be added or averaged. RRF ignores the scores entirely and uses
 * only each result's *rank* in its own list, which makes them combinable
 * without inventing a normalisation.
 *
 * k = 60 is the value from the original paper. It damps the difference between
 * the first few ranks, so a chunk that both retrievers rank reasonably beats
 * one that a single retriever ranks first.
 */
const RRF_K = Number(process.env.RETRIEVAL_RRF_K || 60);

// How deep each retriever goes before fusing. Wider than topK on purpose: a
// chunk ranked 8th by vectors and 3rd by keywords should be able to win.
const FUSION_DEPTH = Number(process.env.RETRIEVAL_FUSION_DEPTH || 20);

function fuse(lists, topK) {
  const scores = new Map();
  const seen = new Map();

  for (const list of lists) {
    list.forEach((item, index) => {
      const key = item.id;
      scores.set(key, (scores.get(key) || 0) + 1 / (RRF_K + index + 1));

      // Keep the richest copy: the vector list carries a cosine score, the
      // keyword list does not.
      const existing = seen.get(key);
      seen.set(key, existing ? { ...existing, ...item, retrievers: [...existing.retrievers, item.retriever] }
                             : { ...item, retrievers: [item.retriever] });
    });
  }

  return [...scores.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, topK)
    .map(([id, rrf]) => ({ ...seen.get(id), rrf: Number(rrf.toFixed(5)) }));
}

function vectorCandidates(queryVector) {
  const rows = sqlite
    .stmt(`SELECT id, doc_id AS docId, title, source, text, embedding,
                  start_line AS startLine, end_line AS endLine
           FROM chunks WHERE embedding IS NOT NULL`)
    .all();

  return rows
    .map((row) => ({
      id: row.id,
      docId: row.docId,
      title: row.title,
      source: row.source,
      text: row.text,
      startLine: row.startLine,
      endLine: row.endLine,
      score: cosineSimilarity(queryVector, sqlite.unpackEmbedding(row.embedding)),
      retriever: 'vector'
    }))
    .sort((a, b) => b.score - a.score)
    .slice(0, FUSION_DEPTH);
}

function keywordCandidates(tokens) {
  if (!tokens.length) return [];

  return sqlite
    .stmt(`SELECT c.id, c.doc_id AS docId, c.title, c.source, c.text,
                  c.start_line AS startLine, c.end_line AS endLine
           FROM chunks_fts JOIN chunks c ON c.rowid = chunks_fts.rowid
           WHERE chunks_fts MATCH ? ORDER BY bm25(chunks_fts) LIMIT ?`)
    .all(toMatchQuery(tokens), FUSION_DEPTH)
    .map((row) => ({ ...row, retriever: 'keyword' }));
}

/**
 * Retrieval, using both indexes together.
 *
 * These used to be either/or: embeddings when available, keywords only as a
 * fallback. That left each one's blind spot uncovered — embeddings recognise a
 * paraphrase but miss a literal identifier like MUM-7741, and keywords do the
 * reverse. Running both and fusing the ranks covers both.
 *
 * `score` stays on the cosine scale so retrievalPolicy's thresholds keep
 * meaning what they meant; `rrf` is the ordering, exposed for inspection.
 */
async function search(query, topK = 4) {
  const { n } = sqlite.stmt('SELECT COUNT(*) AS n FROM chunks').get();
  if (!n) return { matches: [], mode: 'empty' };

  const queryVector = await generateEmbedding(query);
  const tokens = tokenize(query);

  if (queryVector) {
    const vectors = vectorCandidates(queryVector);
    const keywords = keywordCandidates(tokens);

    if (vectors.length) {
      // Nothing to fuse with — keyword search found nothing, or the query was
      // all stop words. Vectors alone, on the same scale as before.
      if (!keywords.length) {
        return { matches: vectors.slice(0, topK), mode: 'embedding' };
      }

      const fused = fuse([vectors, keywords], topK);

      // A chunk only the keyword index found has no cosine score. Score it the
      // way the lexical path always did, so every match is comparable.
      for (const match of fused) {
        if (typeof match.score !== 'number') match.score = lexicalScore(tokens, match.text);
        delete match.retriever;
      }

      return { matches: fused, mode: 'hybrid' };
    }
  }

  // Embeddings unavailable — SQLite's own index rather than scoring every
  // chunk in JavaScript.
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

/**
 * Widens a match with the chunks either side of it in the same document.
 *
 * Retrieval finds the function that answers the question; the line that
 * explains *why* is often in the one above, and the caller in the one below.
 * Chunk ids are `${docId}_c${index}`, so neighbours are addressable directly.
 *
 * Bounded on purpose. Prompt evaluation is the expensive part of a request —
 * measured at 15.8 tok/s — so this expands only the top match, by one chunk
 * each side, and only while the total stays under budget.
 */
function expandContext(matches, { budgetChars = 3000, neighbours = 1 } = {}) {
  if (!matches.length) return matches;

  const [top, ...rest] = matches;
  const parsed = /^(.*)_c(\d+)$/.exec(top.id || '');
  if (!parsed) return matches;

  const [, docId, indexText] = parsed;
  const index = Number(indexText);

  const wanted = [];
  for (let offset = -neighbours; offset <= neighbours; offset += 1) {
    if (offset === 0 || index + offset < 0) continue;
    wanted.push(`${docId}_c${index + offset}`);
  }
  if (!wanted.length) return matches;

  const holes = wanted.map(() => '?').join(',');
  const siblings = sqlite
    .stmt(`SELECT id, text, start_line AS startLine, end_line AS endLine
           FROM chunks WHERE id IN (${holes}) ORDER BY id`)
    .all(...wanted);

  if (!siblings.length) return matches;

  // Reassemble in document order so the excerpt still reads top to bottom.
  const ordered = [...siblings, { id: top.id, text: top.text, startLine: top.startLine, endLine: top.endLine }]
    .sort((a, b) => (a.startLine ?? 0) - (b.startLine ?? 0));

  let used = 0;
  const kept = [];
  for (const piece of ordered) {
    if (used + piece.text.length > budgetChars && kept.length) break;
    kept.push(piece);
    used += piece.text.length;
  }

  const expanded = {
    ...top,
    text: kept.map((p) => p.text).join('\n'),
    startLine: kept[0].startLine ?? top.startLine,
    endLine: kept[kept.length - 1].endLine ?? top.endLine,
    expandedWith: kept.length - 1
  };

  return [expanded, ...rest];
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
  expandContext,
  stats,
  // exported for tests
  chunkText,
  cosineSimilarity,
  lexicalScore,
  tokenize
};
