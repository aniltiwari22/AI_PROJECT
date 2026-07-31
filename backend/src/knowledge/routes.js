const express = require('express');
const vectorStore = require('./vectorStore');
const repoIndexer = require('./repoIndexer');
const excelStore = require('./excelStore');

const router = express.Router();

// GET /api/v1/knowledge — list ingested documents plus store stats
router.get('/', async (req, res, next) => {
  try {
    const [documents, stats] = await Promise.all([vectorStore.listDocuments(), vectorStore.stats()]);
    res.json({ success: true, stats, documents });
  } catch (error) {
    next(error);
  }
});

// POST /api/v1/knowledge — add a document to the internal knowledge base
router.post('/', async (req, res, next) => {
  try {
    const { title, source, text } = req.body || {};
    const result = await vectorStore.addDocument({ title, source, text });
    res.status(201).json({ success: true, ...result });
  } catch (error) {
    next(error);
  }
});

// POST /api/v1/knowledge/search — inspect what retrieval returns for a query
const MAX_TOP_K = 25;

router.post('/search', async (req, res, next) => {
  try {
    const { query, topK } = req.body || {};

    // Must be a real string: an object here stringified to "[object Object]"
    // and silently returned nonsense matches.
    if (typeof query !== 'string' || !query.trim()) {
      return res.status(400).json({ success: false, error: 'query must be a non-empty string' });
    }

    // Clamp: a negative topK reached Array.slice(0, -n), which trims from the
    // end and returned the wrong rows instead of the top matches.
    const requested = Number(topK);
    const limit = Number.isFinite(requested) && requested > 0 ? Math.min(Math.floor(requested), MAX_TOP_K) : 4;

    const result = await vectorStore.search(query, limit);
    res.json({ success: true, ...result });
  } catch (error) {
    next(error);
  }
});

// POST /api/v1/knowledge/explain — retrieval with the working shown, so a bad
// answer can be traced to "never retrieved" or "retrieved but outranked".
router.post('/explain', async (req, res, next) => {
  try {
    const { query, topK } = req.body || {};
    if (typeof query !== 'string' || !query.trim()) {
      return res.status(400).json({ success: false, error: 'query must be a non-empty string' });
    }
    const limit = Math.min(Math.max(Number(topK) || 8, 1), 25);
    res.json({ success: true, ...(await vectorStore.explain(query.trim(), limit)) });
  } catch (error) {
    next(error);
  }
});

// --- curated answers ------------------------------------------------------

// GET /api/v1/knowledge/sheets — what can be saved into, and the shape of each.
router.get('/sheets', (req, res) => {
  res.json({
    success: true,
    sheets: excelStore.SHEETS.map((s) => ({ name: s.name, columns: s.columns, keys: s.keys }))
  });
});

/**
 * POST /api/v1/knowledge/curate — promote an answer into the workbook.
 *
 * A curated row is answered with no model call at all, which on this hardware
 * is the difference between instant and ~42 seconds.
 */
router.post('/curate', async (req, res, next) => {
  try {
    const { sheet, values } = req.body || {};
    if (typeof sheet !== 'string' || !sheet.trim()) {
      return res.status(400).json({ success: false, error: 'sheet is required' });
    }
    if (!values || typeof values !== 'object' || Array.isArray(values)) {
      return res.status(400).json({ success: false, error: 'values must be an object of column -> text' });
    }
    res.status(201).json({ success: true, ...(await excelStore.addRow(sheet.trim(), values)) });
  } catch (error) {
    next(error);
  }
});

// --- repository indexing ---------------------------------------------------
// Read-only: these walk and read a folder, and never write to it.

router.get('/repos', async (req, res, next) => {
  try {
    res.json({ success: true, repos: await repoIndexer.listRepos() });
  } catch (error) {
    next(error);
  }
});

// Dry run first — indexing a repo costs minutes of embedding on CPU, so the
// cost should be visible before it is spent.
router.post('/repos/preview', async (req, res, next) => {
  try {
    const { root } = req.body || {};
    if (typeof root !== 'string' || !root.trim()) {
      return res.status(400).json({ success: false, error: 'root must be a folder path' });
    }
    res.json({ success: true, ...(await repoIndexer.previewRepo(root.trim())) });
  } catch (error) {
    next(error);
  }
});

// Streams NDJSON progress: on this hardware a repo takes minutes, and silence
// is indistinguishable from a hang.
router.post('/repos', async (req, res, next) => {
  const { root } = req.body || {};
  if (typeof root !== 'string' || !root.trim()) {
    return res.status(400).json({ success: false, error: 'root must be a folder path' });
  }

  const upstream = new AbortController();
  res.on('close', () => { if (!res.writableFinished) upstream.abort(); });

  try {
    res.setHeader('Content-Type', 'application/x-ndjson; charset=utf-8');
    res.setHeader('Cache-Control', 'no-cache');

    const summary = await repoIndexer.indexRepo(root.trim(), {
      signal: upstream.signal,
      onProgress: (p) => {
        if (res.writableEnded) return;
        res.write(`${JSON.stringify({ progress: p })}\n`);
      }
    });

    if (!res.writableEnded) {
      res.write(`${JSON.stringify({ done: summary })}\n`);
      res.end();
    }
  } catch (error) {
    if (res.headersSent) {
      if (!res.writableEnded) {
        res.write(`${JSON.stringify({ error: error.message })}\n`);
        res.end();
      }
      return;
    }
    next(error);
  }
});

router.delete('/repos', async (req, res, next) => {
  try {
    const { root } = req.body || {};
    if (typeof root !== 'string' || !root.trim()) {
      return res.status(400).json({ success: false, error: 'root must be a folder path' });
    }
    const result = await repoIndexer.removeRepo(root.trim());
    if (!result.documents) return res.status(404).json({ success: false, error: 'That folder is not indexed' });
    res.json({ success: true, ...result });
  } catch (error) {
    next(error);
  }
});

// DELETE /api/v1/knowledge/:id
router.delete('/:id', async (req, res, next) => {
  try {
    const result = await vectorStore.deleteDocument(req.params.id);
    if (!result.deleted) {
      return res.status(404).json({ success: false, error: 'Document not found' });
    }
    res.json({ success: true });
  } catch (error) {
    next(error);
  }
});

module.exports = router;
