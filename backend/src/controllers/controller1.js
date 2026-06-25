const { processPrompt } = require('../services/chatEngine');

module.exports = {
  async handlePrompt(req, res, next) {
    try {
      const responseText = await processPrompt(req.body.prompt);
      return res.status(200).json({ success: true, data: responseText });
    } catch (error) {
      next(error);
    }
  }
};
