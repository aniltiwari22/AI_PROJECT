const express = require('express');
const { extractContent } = require('./extract');
const store = require('./store');
const vectorStore = require('../knowledge/vectorStore');

const router = express.Router();

const MAX_UPLOAD_BYTES = Number(process.env.UPLOAD_MAX_BYTES || 20 * 1024 * 1024);

// Uploads arrive as base64 JSON rather than multipart: no multipart parser can
// be installed here, and base64 keeps the client trivial. express.json's limit
// is raised to match in app.js.
router.post('/', async (req, res, next) => {
  try {
    const { filename, mimeType, data, addToKnowledge } = req.body || {};

    if (typeof filename !== 'string' || !filename.trim() || typeof data !== 'string' || !data) {
      return res.status(400).json({
        success: false,
        error: 'filename and data (base64) are required, and both must be strings'
      });
    }

    // Accept both a bare base64 string and a full data: URL.
    const base64 = data.replace(/^data:[^;]+;base64,/, '').replace(/\s+/g, '');

    // Buffer.from(..., 'base64') never throws — it silently discards anything
    // that is not a base64 character. A corrupt upload therefore used to be
    // stored as a few bytes of garbage and reported as success, so the input is
    // checked explicitly first.
    if (!/^[A-Za-z0-9+/]*={0,2}$/.test(base64) || base64.length % 4 !== 0) {
      return res.status(400).json({ success: false, error: 'data is not valid base64' });
    }

    const buffer = Buffer.from(base64, 'base64');

    if (!buffer.length) {
      return res.status(400).json({ success: false, error: 'File is empty' });
    }
    if (buffer.length > MAX_UPLOAD_BYTES) {
      return res.status(413).json({
        success: false,
        error: `File is ${(buffer.length / 1048576).toFixed(1)}MB; the limit is ${(MAX_UPLOAD_BYTES / 1048576).toFixed(0)}MB`
      });
    }

    const extracted = await extractContent({ buffer, filename, mimeType });

    const record = await store.saveFile({
      filename,
      kind: extracted.kind,
      mimeType,
      text: extracted.text,
      warning: extracted.warning,
      meta: extracted.meta,
      bytes: buffer.length
    });

    // Optionally make the document searchable for future questions too.
    let knowledgeId = null;
    if (addToKnowledge && extracted.text) {
      try {
        const saved = await vectorStore.addDocument({
          title: filename,
          source: `upload:${record.id}`,
          text: extracted.text
        });
        knowledgeId = saved.id;
      } catch (error) {
        console.warn(`Could not add upload to knowledge base: ${error.message}`);
      }
    }

    res.status(201).json({
      success: true,
      id: record.id,
      filename: record.filename,
      kind: record.kind,
      chars: record.chars,
      pages: record.meta?.pages,
      truncated: record.truncated,
      warning: record.warning,
      preview: record.text.slice(0, 300),
      knowledgeId
    });
  } catch (error) {
    next(error);
  }
});

router.get('/', async (req, res, next) => {
  try {
    res.json({ success: true, files: await store.listFiles() });
  } catch (error) {
    next(error);
  }
});

router.delete('/:id', async (req, res, next) => {
  try {
    const result = await store.deleteFile(req.params.id);
    if (!result.deleted) return res.status(404).json({ success: false, error: 'File not found' });
    res.json({ success: true });
  } catch (error) {
    next(error);
  }
});

module.exports = router;
