module.exports = {
  validatePayload(req, res, next) {
    if (req.method !== 'POST') return next();

    const prompt = req.body?.prompt;

    // Truthiness alone is not enough: an object, array or number is truthy, so
    // it used to reach the model as "[object Object]" and cost a full
    // generation — minutes of CPU — before producing nonsense.
    if (typeof prompt !== 'string' || !prompt.trim()) {
      return res.status(400).json({
        success: false,
        error: 'Malformed payload: prompt must be a non-empty string.'
      });
    }

    return next();
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
