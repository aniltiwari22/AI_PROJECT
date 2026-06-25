const axios = require('axios');

module.exports = {
  async generateEmbeddings(text) {
    try {
      const OLLAMA_URL = process.env.OLLAMA_BASE_URL || 'http://localhost:11434';
      const response = await axios.post(`${OLLAMA_URL}/api/embeddings`, {
        model: 'nomic-embed-text',
        prompt: text
      });
      return response.data.embedding;
    } catch (error) {
      console.error('Vector Generation Failure:', error.message);
      return new Array(384).fill(0);
    }
  }
};