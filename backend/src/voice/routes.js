const express = require('express');
const crypto = require('crypto');
const voiceLogger = require('../logging/voiceLogger');

const router = express.Router();

/**
 * Voice session bookkeeping and logging.
 *
 * Speech recognition and synthesis happen in the browser, so no audio ever
 * reaches this server — these endpoints exist to track sessions and record
 * what was asked, in which language, and how it was answered.
 */

const sessions = new Map();
const MAX_SESSIONS = 200;

function pruneSessions() {
  if (sessions.size <= MAX_SESSIONS) return;
  // Oldest first — Map preserves insertion order.
  const excess = sessions.size - MAX_SESSIONS;
  let removed = 0;
  for (const key of sessions.keys()) {
    sessions.delete(key);
    if (++removed >= excess) break;
  }
}

router.post('/session', (req, res) => {
  const id = `vs_${crypto.randomBytes(6).toString('hex')}`;
  sessions.set(id, {
    id,
    language: req.body?.language || 'auto',
    startedAt: new Date().toISOString(),
    turns: 0,
    interruptions: 0
  });
  pruneSessions();
  res.status(201).json({ success: true, sessionId: id });
});

router.get('/session/:id', (req, res) => {
  const session = sessions.get(req.params.id);
  if (!session) return res.status(404).json({ success: false, error: 'Session not found' });
  res.json({ success: true, session });
});

/** Records one completed voice turn. Fire-and-forget from the client. */
router.post('/turn', (req, res) => {
  const { sessionId, language, transcript, sttConfidence, origin, confidence, responseMs, answer, spoken, interrupted } =
    req.body || {};

  if (!transcript) {
    return res.status(400).json({ success: false, error: 'transcript is required' });
  }

  const session = sessionId ? sessions.get(sessionId) : null;
  if (session) {
    session.turns += 1;
    if (interrupted) session.interruptions += 1;
    session.language = language || session.language;
  }

  voiceLogger.log({
    sessionId: sessionId || '',
    language: language || '',
    transcript,
    sttConfidence,
    origin,
    confidence,
    responseMs,
    answer,
    spoken,
    interrupted
  });

  res.status(202).json({ success: true });
});

router.get('/history', async (req, res, next) => {
  try {
    const stats = await voiceLogger.stats();
    res.json({
      success: true,
      ...stats,
      activeSessions: sessions.size,
      sessions: [...sessions.values()].slice(-20)
    });
  } catch (error) {
    next(error);
  }
});

module.exports = router;
