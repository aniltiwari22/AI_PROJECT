const { generateEmbedding } = require('../config/ollama');
const sqlite = require('../storage/sqlite');

/**
 * Embedding-based answer cache. A repeat of a question — or a close paraphrase
 * of one — is returned instantly instead of costing another ~35s generation.
 * Matching is semantic, so "what is error 101804" hits an entry stored for
 * "why error 101804".
 *
 * Previously a JSON file rewritten in full on every write. Each entry carries
 * a 768-float embedding, which cost 15.4KB as JSON text; at the 500-entry cap
 * that meant re-reading and re-writing 7.5MB to record one answer. As packed
 * BLOBs the same vector is 3KB, and only the changed row is written.
 */

// 0.95 is deliberately strict: a false hit serves a wrong answer with total
// confidence, which is far worse than paying for a fresh generation.
const THRESHOLD = Number(process.env.CACHE_SIMILARITY || 0.95);
const MAX_ENTRIES = Number(process.env.CACHE_MAX_ENTRIES || 500);
const TTL_MS = Number(process.env.CACHE_TTL_MS || 7 * 24 * 60 * 60 * 1000);

function cosine(a, b) {
  if (!a || !b || a.length !== b.length) return 0;
  let dot = 0;
  let na = 0;
  let nb = 0;
  for (let i = 0; i < a.length; i += 1) {
    dot += a[i] * b[i];
    na += a[i] * a[i];
    nb += b[i] * b[i];
  }
  if (!na || !nb) return 0;
  return dot / (Math.sqrt(na) * Math.sqrt(nb));
}

/**
 * @returns {Promise<{hit:boolean, similarity:number, answer?:string, origin?:string, sources?:array}>}
 */
async function lookup(question) {
  const { n } = sqlite.stmt('SELECT COUNT(*) AS n FROM cache').get();
  if (!n) return { hit: false, similarity: 0 };

  const vector = await generateEmbedding(question);
  // Without embeddings a "semantic" cache would degrade to exact string match,
  // which is misleading; skip rather than pretend.
  if (!vector) return { hit: false, similarity: 0, reason: 'embeddings unavailable' };

  const now = Date.now();
  // Expiry is a WHERE clause now rather than a filter over every row in Node.
  const rows = sqlite
    .stmt('SELECT id, question, answer, origin, sources, embedding FROM cache WHERE created_at > ?')
    .all(now - TTL_MS);

  let best = null;
  for (const row of rows) {
    const similarity = cosine(vector, sqlite.unpackEmbedding(row.embedding));
    if (!best || similarity > best.similarity) best = { similarity, row };
  }

  if (!best || best.similarity < THRESHOLD) {
    return { hit: false, similarity: best ? Number(best.similarity.toFixed(3)) : 0 };
  }

  // Hit accounting is a targeted UPDATE — no read-modify-write of the store.
  sqlite.stmt('UPDATE cache SET hits = hits + 1, last_used = ? WHERE id = ?').run(now, best.row.id);

  return {
    hit: true,
    similarity: Number(best.similarity.toFixed(3)),
    answer: best.row.answer,
    origin: best.row.origin,
    sources: best.row.sources ? JSON.parse(best.row.sources) : [],
    question: best.row.question
  };
}

async function remember({ question, answer, origin, sources }) {
  if (!answer || !answer.trim()) return;
  // Web answers go stale; caching them would serve yesterday's news as current.
  if (origin === 'web') return;

  const vector = await generateEmbedding(question);
  if (!vector) return;

  const now = Date.now();

  sqlite.transaction(() => {
    sqlite
      .stmt(`INSERT INTO cache (question, answer, origin, sources, embedding, created_at, last_used, hits)
             VALUES (?, ?, ?, ?, ?, ?, ?, 0)`)
      .run(question, answer, origin || null, JSON.stringify(sources || []),
        sqlite.packEmbedding(vector), now, now);

    // Evict least-recently-used once over budget, in one statement.
    sqlite
      .stmt(`DELETE FROM cache WHERE id IN (
               SELECT id FROM cache ORDER BY last_used DESC LIMIT -1 OFFSET ?
             )`)
      .run(MAX_ENTRIES);
  })();
}

async function clear() {
  sqlite.stmt('DELETE FROM cache').run();
}

async function stats() {
  const row = sqlite
    .stmt('SELECT COUNT(*) AS entries, COALESCE(SUM(hits), 0) AS totalHits FROM cache')
    .get();

  return {
    file: sqlite.DB_FILE,
    entries: row.entries,
    totalHits: row.totalHits,
    threshold: THRESHOLD
  };
}

module.exports = { lookup, remember, clear, stats, cosine };
