const { processPrompt } = require('../services/chatEngine');
const excelLogger = require('../logging/excelLogger');
const { OLLAMA_MODEL, resolveModel } = require('../config/ollama');

const MAX_HISTORY_ENTRIES = 20;

// History comes straight from a client, so entries may be null, malformed, or
// unbounded. Normalise at the boundary rather than trusting it downstream.
function sanitizeHistory(raw) {
  if (!Array.isArray(raw)) return [];

  return raw
    .filter((turn) => turn && typeof turn === 'object' && typeof turn.content === 'string' && turn.content.trim())
    .map((turn) => ({
      role: turn.role === 'assistant' ? 'assistant' : 'user',
      content: turn.content
    }))
    .slice(-MAX_HISTORY_ENTRIES);
}

function readFileIds(raw) {
  return Array.isArray(raw) ? raw.filter((id) => typeof id === 'string') : [];
}

// Fire-and-forget: the Excel write must never sit in the request path.
function logRequest(req, result, responseMs, model) {
  excelLogger.log({
    user: req.body?.user || 'web',
    question: req.body?.prompt,
    origin: result.origin,
    confidence: result.confidence,
    responseMs,
    // Log what actually answered, not the configured default — otherwise the
    // benchmark view attributes every timing to the wrong model.
    model: model || OLLAMA_MODEL,
    answer: result.answer,
    sources: result.sources
  });
}

module.exports = {
  /**
   * Streams newline-delimited JSON when the client asks for it:
   *   {"stage":"…"}  progress label
   *   {"token":"…"}  incremental answer text
   *   {"reset":true} discard what was streamed; another attempt follows
   *   {"done":{…}}   final answer plus origin/sources
   *   {"error":"…"}  failure after streaming already began
   * Non-streaming clients get the original single JSON body unchanged.
   */
  async handlePrompt(req, res, next) {
    const wantsStream = req.body?.stream === true;

    // Validated against the models Ollama actually has: an unknown name would
    // make Ollama try to pull it, which hangs on an offline machine.
    const model = await resolveModel(req.body?.model);

    if (!wantsStream) {
      try {
        const started = Date.now();
        const result = await processPrompt(
          req.body.prompt,
          sanitizeHistory(req.body.history),
          readFileIds(req.body.fileIds),
          { model }
        );
        logRequest(req, result, Date.now() - started, model);

        return res.status(200).json({
          success: true,
          data: result.answer,
          origin: result.origin,
          confidence: result.confidence,
          sources: result.sources,
          trace: result.trace,
          timeline: result.timeline,
          totalMs: result.totalMs,
          telemetry: result.telemetry
        });
      } catch (error) {
        return next(error);
      }
    }

    let started = false;
    let clientGone = false;
    const startedAt = Date.now();

    // When the user hits Stop the browser aborts the fetch, which closes this
    // socket. Ollama does NOT notice on its own and would keep generating,
    // pinning an already-slow CPU, so cancellation is forwarded upstream.
    const upstream = new AbortController();

    // Must listen on `res`, not `req`: req's 'close' fires as soon as the
    // request body has been consumed, which for a small POST is immediately —
    // that made every stream look cancelled and swallowed the done event.
    // res 'close' with writableFinished === false means a genuine disconnect.
    res.on('close', () => {
      if (!res.writableFinished) {
        clientGone = true;
        upstream.abort();
      }
    });

    const send = (payload) => {
      if (clientGone) return;
      started = true;
      res.write(`${JSON.stringify(payload)}\n`);
      // Without an explicit flush, compression/proxy buffering can hold tokens
      // back and defeat the point of streaming.
      if (typeof res.flush === 'function') res.flush();
    };

    try {
      res.setHeader('Content-Type', 'application/x-ndjson; charset=utf-8');
      res.setHeader('Cache-Control', 'no-cache');
      res.setHeader('X-Accel-Buffering', 'no');

      const result = await processPrompt(
        req.body.prompt,
        sanitizeHistory(req.body.history),
        readFileIds(req.body.fileIds),
        {
          model,
          signal: upstream.signal,
          onStage: (stage) => send({ stage }),
          onToken: (token) => send({ token }),
          onReset: () => send({ reset: true })
        }
      );

      if (clientGone) return res.end();

      logRequest(req, result, Date.now() - startedAt, model);

      send({
        done: {
          data: result.answer,
          origin: result.origin,
          confidence: result.confidence,
          sources: result.sources,
          trace: result.trace,
          timeline: result.timeline,
          totalMs: result.totalMs,
          telemetry: result.telemetry
        }
      });
      res.end();
    } catch (error) {
      // A cancelled request is the user's intent, not a failure to report.
      if (clientGone) {
        if (!res.writableEnded) res.end();
        return;
      }
      if (started) {
        // Status is already committed to 200, so the failure travels in-band.
        send({ error: error.message });
        return res.end();
      }
      next(error);
    }
  },

  // exported for tests
  sanitizeHistory
};
