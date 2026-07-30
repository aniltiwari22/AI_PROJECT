const express = require('express');
const router = express.Router();
const controller1 = require('../controllers/controller1');
const { validatePayload } = require('../middleware/middleware1');
const { listChatModels, OLLAMA_MODEL } = require('../config/ollama');

router.post('/query', validatePayload, controller1.handlePrompt);

// Feeds the composer's model picker. Answers with an empty list rather than an
// error when Ollama is unreachable, so the picker degrades to the default
// instead of breaking the page.
router.get('/models', async (req, res) => {
  try {
    res.json({ success: true, default: OLLAMA_MODEL, models: await listChatModels() });
  } catch (error) {
    res.json({ success: false, default: OLLAMA_MODEL, models: [], error: error.message });
  }
});

module.exports = router;
