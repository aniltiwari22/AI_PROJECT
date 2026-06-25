module.exports = {
  validatePayload(req, res, next) {
    if (req.method === 'POST' && (!req.body || !req.body.prompt)) {
      return res.status(400).json({ error: 'Malformed payload: Prompt key data missing.' });
    }
    next();
  },

  errorHandler(err, req, res, next) {
    const statusCode = err.statusCode || 500;
    const message = err.message || 'Internal Ashu Codex AI Server Breakdown.';

    if (statusCode === 503) {
      console.warn(`[Service Unavailable]: ${message}`);
    } else if (statusCode >= 500) {
      console.error(`[Error Trace]: ${message}`);
    }

    res.status(statusCode).json({
      success: false,
      error: message
    });
  }
};
