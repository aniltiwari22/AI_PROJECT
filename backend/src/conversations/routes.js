const express = require('express');
const store = require('./store');

const router = express.Router();

// GET /api/v1/conversations — sidebar listing
router.get('/', (req, res, next) => {
  try {
    res.json({
      success: true,
      conversations: store.list({ includeArchived: req.query.archived === 'true' }),
      stats: store.stats()
    });
  } catch (error) {
    next(error);
  }
});

// GET /api/v1/conversations/search?q= — across every message
router.get('/search', (req, res, next) => {
  try {
    const q = typeof req.query.q === 'string' ? req.query.q.trim() : '';
    if (!q) return res.json({ success: true, results: [] });
    res.json({ success: true, results: store.search(q) });
  } catch (error) {
    next(error);
  }
});

router.post('/', (req, res, next) => {
  try {
    res.status(201).json({ success: true, conversation: store.create({ title: req.body?.title }) });
  } catch (error) {
    next(error);
  }
});

router.get('/:id', (req, res, next) => {
  try {
    const conversation = store.get(req.params.id);
    if (!conversation) return res.status(404).json({ success: false, error: 'No such conversation' });
    res.json({ success: true, conversation });
  } catch (error) {
    next(error);
  }
});

// Appending is a separate call from /chat/query on purpose: a turn is only
// worth storing once it has actually completed, and the client knows that.
router.post('/:id/messages', (req, res, next) => {
  try {
    const { role, text } = req.body || {};
    if (typeof text !== 'string') {
      return res.status(400).json({ success: false, error: 'text must be a string' });
    }
    res.status(201).json({ success: true, message: store.addMessage(req.params.id, { ...req.body, role, text }) });
  } catch (error) {
    next(error);
  }
});

router.patch('/:id', (req, res, next) => {
  try {
    const { title, pinned, archived } = req.body || {};
    const done = {};

    if (typeof title === 'string') done.rename = store.rename(req.params.id, title);
    if (typeof pinned === 'boolean') done.pinned = store.setFlag(req.params.id, 'pinned', pinned);
    if (typeof archived === 'boolean') done.archived = store.setFlag(req.params.id, 'archived', archived);

    if (!Object.keys(done).length) {
      return res.status(400).json({ success: false, error: 'Nothing to update' });
    }
    res.json({ success: true, ...done });
  } catch (error) {
    next(error);
  }
});

router.delete('/:id', (req, res, next) => {
  try {
    const result = store.remove(req.params.id);
    if (!result.deleted) return res.status(404).json({ success: false, error: 'No such conversation' });
    res.json({ success: true });
  } catch (error) {
    next(error);
  }
});

module.exports = router;
