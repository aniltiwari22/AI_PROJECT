const axios = require('axios');

const OLLAMA_BASE_URL = process.env.OLLAMA_BASE_URL || 'http://localhost:11434';
const OLLAMA_MODEL = process.env.OLLAMA_MODEL || 'llama3';
const OLLAMA_TIMEOUT_MS = Number(process.env.OLLAMA_TIMEOUT_MS || 180000);
const OLLAMA_KEEP_ALIVE = process.env.OLLAMA_KEEP_ALIVE || '30m';
const OLLAMA_NUM_PREDICT = Number(process.env.OLLAMA_NUM_PREDICT || 90);
const OLLAMA_NUM_CTX = Number(process.env.OLLAMA_NUM_CTX || 1024);

const ollamaClient = axios.create({
  baseURL: OLLAMA_BASE_URL,
  headers: { 'Content-Type': 'application/json' },
  timeout: OLLAMA_TIMEOUT_MS
});

function createOllamaError(message, statusCode = 503) {
  const error = new Error(message);
  error.statusCode = statusCode;
  return error;
}

function normalizeOllamaError(error) {
  if (error.code === 'ECONNABORTED') {
    return createOllamaError(
      `Ollama did not respond within ${Math.round(OLLAMA_TIMEOUT_MS / 1000)} seconds. Increase OLLAMA_TIMEOUT_MS if this model needs more time.`
    );
  }

  if (error.code === 'ECONNREFUSED' || error.code === 'ENOTFOUND' || error.code === 'ETIMEDOUT') {
    return createOllamaError(
      `Ollama is not reachable at ${OLLAMA_BASE_URL}. Start Ollama or set OLLAMA_BASE_URL to the correct address.`
    );
  }

  if (error.response?.status === 404) {
    return createOllamaError(
      `Ollama model "${OLLAMA_MODEL}" is not available. Pull it with: ollama pull ${OLLAMA_MODEL}`,
      503
    );
  }

  if (error.response?.data?.error) {
    return createOllamaError(error.response.data.error, error.response.status || 503);
  }

  return createOllamaError('Ollama failed to generate a response.');
}

module.exports = {
  OLLAMA_BASE_URL,
  OLLAMA_MODEL,
  OLLAMA_TIMEOUT_MS,
  OLLAMA_KEEP_ALIVE,
  OLLAMA_NUM_PREDICT,
  OLLAMA_NUM_CTX,

  async checkOllama() {
    const response = await ollamaClient.get('/api/tags');
    const models = Array.isArray(response.data?.models) ? response.data.models : [];

    return {
      connected: true,
      baseUrl: OLLAMA_BASE_URL,
      model: OLLAMA_MODEL,
      timeoutMs: OLLAMA_TIMEOUT_MS,
      keepAlive: OLLAMA_KEEP_ALIVE,
      numPredict: OLLAMA_NUM_PREDICT,
      modelAvailable: models.some((item) => item.name === OLLAMA_MODEL || item.name?.startsWith(`${OLLAMA_MODEL}:`))
    };
  },

  async warmupOllama() {
    try {
      await ollamaClient.post('/api/generate', {
        model: OLLAMA_MODEL,
        prompt: 'ok',
        stream: false,
        keep_alive: OLLAMA_KEEP_ALIVE,
        options: {
          num_predict: 1,
          num_ctx: 512,
          temperature: 0
        }
      });

      console.log(`Ollama model "${OLLAMA_MODEL}" is warm and ready.`);
    } catch (error) {
      const normalizedError = normalizeOllamaError(error);
      console.warn(`Ollama warm-up skipped: ${normalizedError.message}`);
    }
  },

  async generateCompletion(model, prompt, systemPrompt = '') {
    try {
      const payload = {
        model: model || OLLAMA_MODEL,
        prompt: systemPrompt ? `${systemPrompt}\n\n${prompt}` : prompt,
        stream: false,
        keep_alive: OLLAMA_KEEP_ALIVE,
        options: {
          num_predict: OLLAMA_NUM_PREDICT,
          num_ctx: OLLAMA_NUM_CTX,
          num_thread: Number(process.env.OLLAMA_NUM_THREAD || 0) || undefined,
          temperature: 0.2,
          top_p: 0.9
        }
      };

      const response = await ollamaClient.post('/api/generate', {
        ...payload
      });
      return response.data;
    } catch (error) {
      const normalizedError = normalizeOllamaError(error);
      console.error(`Ollama Pipeline Core Error: ${normalizedError.message}`);
      throw normalizedError;
    }
  }
};
