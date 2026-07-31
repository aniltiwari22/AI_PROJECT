const axios = require('axios');
const os = require('os');

// Left to Ollama's own heuristic by default. Benchmarked on this 4c/8t CPU:
// all 8 logical threads gave ~3.5 tok/s versus ~2.3 tok/s when pinned to the 4
// physical cores, so restricting it is a pessimisation. Override only if you
// have measured otherwise on your hardware.
const NUM_THREAD = Number(process.env.OLLAMA_NUM_THREAD || 0) || undefined;

const OLLAMA_BASE_URL = process.env.OLLAMA_BASE_URL || 'http://localhost:11434';
// The fallback has to name a model that is actually installed. It used to say
// 'llama3', which was then removed — so an unset OLLAMA_MODEL would have made
// Ollama try to pull it over the network, hanging on an offline machine.
const OLLAMA_MODEL = process.env.OLLAMA_MODEL || 'qwen2.5-coder:7b';

// Models that cannot answer a chat turn. Offering them in the picker would let
// the user select one and get an error or gibberish instead of an answer.
const EXCLUDED_FROM_CHAT = ['nomic-embed-text', 'mxbai-embed', 'all-minilm', 'snowflake-arctic-embed'];
const MODEL_CACHE_MS = 60_000;
let modelCache = null;
const OLLAMA_TIMEOUT_MS = Number(process.env.OLLAMA_TIMEOUT_MS || 180000);
const OLLAMA_KEEP_ALIVE = process.env.OLLAMA_KEEP_ALIVE || '30m';
// 90 truncated real answers mid-sentence (observed: '...This version was'). With
// streaming the user sees tokens immediately, so a higher cap costs perceived
// speed almost nothing while removing the truncation entirely.
const OLLAMA_NUM_PREDICT = Number(process.env.OLLAMA_NUM_PREDICT || 512);
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

// Axios surfaces an aborted signal as CanceledError / ERR_CANCELED, and the
// underlying stream can also emit a bare AbortError.
function isCancellation(error) {
  return (
    error?.code === 'ERR_CANCELED' ||
    error?.name === 'CanceledError' ||
    error?.name === 'AbortError'
  );
}

function normalizeOllamaError(error, timeoutUsedMs) {
  if (error.code === 'ECONNABORTED') {
    // Report the timeout that actually applied — vision requests use their own,
    // and quoting the chat timeout here sent debugging down the wrong path.
    const applied = timeoutUsedMs || error.config?.timeout || OLLAMA_TIMEOUT_MS;
    const varName = applied === OLLAMA_TIMEOUT_MS ? 'OLLAMA_TIMEOUT_MS' : 'VISION_TIMEOUT_MS';
    return createOllamaError(
      `Ollama did not respond within ${Math.round(applied / 1000)} seconds. Increase ${varName} if this model needs more time.`
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

const OLLAMA_EMBED_MODEL = process.env.OLLAMA_EMBED_MODEL || 'nomic-embed-text';

// Image reading runs on a multimodal model, separate from the chat model.
// It must NOT linger in memory: this machine cannot hold both 7B models at
// once (10.7GB of 16.9GB), and keeping the vision model resident pushed the
// chat model into swap and made every reply crawl. Unload it right after use.
const OLLAMA_VISION_MODEL = process.env.OLLAMA_VISION_MODEL || 'qwen2.5vl:7b';
const VISION_KEEP_ALIVE = process.env.VISION_KEEP_ALIVE || '0';
const VISION_NUM_PREDICT = Number(process.env.VISION_NUM_PREDICT || 600);
// Vision on CPU is slow, so it gets a longer allowance than a chat turn.
const VISION_TIMEOUT_MS = Number(process.env.VISION_TIMEOUT_MS || 600000);

// Ollama reloads the model whenever num_ctx changes, which costs ~90-170s on
// this hardware. Grounded answers need ~4k tokens, so every request — warm-up
// included — uses one shared size to keep the model resident. The configured
// OLLAMA_NUM_CTX acts as a floor, never a smaller competing value.
const GROUNDED_NUM_CTX = Number(process.env.GROUNDED_NUM_CTX || 2048);
const EFFECTIVE_NUM_CTX = Math.max(OLLAMA_NUM_CTX, GROUNDED_NUM_CTX);

// Embedding support degrades instead of failing: try the dedicated embedding
// model, fall back to the chat model, and let the caller fall back to lexical
// scoring if neither works (e.g. no embedding model has been pulled yet).
let embedModelInUse = null;
let embedDisabled = false;

// Ollama streams newline-delimited JSON, one object per token fragment.
// /api/chat puts the text in message.content, /api/generate in response.
// `signal` propagates cancellation upstream: without it, a client that walks
// away leaves Ollama generating to completion and pinning the CPU.
function fragmentOf(parsed) {
  return parsed.message?.content ?? parsed.response ?? '';
}

function streamCompletion(endpoint, payload, onToken, signal) {
  return ollamaClient
    .post(endpoint, { ...payload, stream: true }, { responseType: 'stream', signal })
    .then(
      (response) =>
        new Promise((resolve, reject) => {
          let full = '';
          let buffer = '';
          // Ollama reports token counts and timings only on the final chunk.
          let stats = {};

          const consume = (line) => {
            const trimmed = line.trim();
            if (!trimmed) return;
            try {
              const parsed = JSON.parse(trimmed);
              const piece = fragmentOf(parsed);
              if (piece) {
                full += piece;
                onToken(piece);
              }
              if (parsed.done) {
                stats = {
                  promptTokens: parsed.prompt_eval_count,
                  outputTokens: parsed.eval_count,
                  promptMs: Math.round((parsed.prompt_eval_duration || 0) / 1e6),
                  generateMs: Math.round((parsed.eval_duration || 0) / 1e6),
                  loadMs: Math.round((parsed.load_duration || 0) / 1e6)
                };
              }
            } catch {
              // ignore a partial/malformed line and keep streaming
            }
          };

          response.data.on('data', (chunk) => {
            buffer += chunk.toString('utf8');
            let index;
            while ((index = buffer.indexOf('\n')) !== -1) {
              consume(buffer.slice(0, index));
              buffer = buffer.slice(index + 1);
            }
          });
          response.data.on('end', () => {
            consume(buffer);
            resolve({ text: full, stats });
          });
          response.data.on('error', reject);
        })
    );
}

async function tryEmbed(model, text) {
  const response = await ollamaClient.post('/api/embeddings', { model, prompt: text });
  const vector = response.data?.embedding;
  if (!Array.isArray(vector) || !vector.length) throw new Error('empty embedding');
  return vector;
}

module.exports = {
  OLLAMA_BASE_URL,
  OLLAMA_MODEL,
  OLLAMA_TIMEOUT_MS,
  OLLAMA_KEEP_ALIVE,
  OLLAMA_NUM_PREDICT,
  OLLAMA_NUM_CTX,
  OLLAMA_EMBED_MODEL,

  OLLAMA_VISION_MODEL,

  embeddingStatus() {
    return { enabled: !embedDisabled, model: embedModelInUse };
  },

  async visionStatus() {
    try {
      const response = await ollamaClient.get('/api/tags');
      const models = Array.isArray(response.data?.models) ? response.data.models : [];
      const available = models.some(
        (m) => m.name === OLLAMA_VISION_MODEL || m.name?.startsWith(`${OLLAMA_VISION_MODEL.split(':')[0]}:`)
      );
      return { enabled: available, model: OLLAMA_VISION_MODEL };
    } catch {
      return { enabled: false, model: OLLAMA_VISION_MODEL };
    }
  },

  /**
   * Reads an image with the vision model. `base64` must be bare base64 with no
   * data: URL prefix. Vision runs on a separate model from chat, so it uses its
   * own context size and cannot disturb the chat model's resident context.
   */
  async describeImage(base64, instruction) {
    try {
      // NOTE: an app-level "evict the chat model first" step was tried here and
      // removed — `keep_alive: 0` with no prompt did not reliably unload, so it
      // only added a wasted round-trip. Ollama owns model residency: set
      // OLLAMA_MAX_LOADED_MODELS=1 on the Ollama server to stop both 7B models
      // (≈10.7GB) being held at once on a 16GB machine.

      const response = await ollamaClient.post(
        '/api/generate',
        {
          model: OLLAMA_VISION_MODEL,
          prompt: instruction,
          images: [base64],
          stream: false,
          keep_alive: VISION_KEEP_ALIVE,
          options: { num_predict: VISION_NUM_PREDICT, temperature: 0.1, num_thread: NUM_THREAD }
        },
        { timeout: VISION_TIMEOUT_MS }
      );
      return response.data?.response || '';
    } catch (error) {
      if (error.response?.status === 404) {
        throw createOllamaError(
          `Vision model "${OLLAMA_VISION_MODEL}" is not available. Pull it with: ollama pull ${OLLAMA_VISION_MODEL}`
        );
      }
      throw normalizeOllamaError(error, VISION_TIMEOUT_MS);
    }
  },

  // Returns null (never throws) when embeddings are unavailable, so retrieval
  // can silently degrade to keyword matching.
  async generateEmbedding(text) {
    if (embedDisabled) return null;

    const candidates = embedModelInUse ? [embedModelInUse] : [OLLAMA_EMBED_MODEL, OLLAMA_MODEL];

    for (const model of candidates) {
      try {
        const vector = await tryEmbed(model, text);
        if (embedModelInUse !== model) {
          embedModelInUse = model;
          console.log(`Embeddings using model "${model}".`);
        }
        return vector;
      } catch {
        // try the next candidate
      }
    }

    embedDisabled = true;
    console.warn(
      `No usable embedding model (tried: ${candidates.join(', ')}). ` +
        `Falling back to keyword search. Pull one with: ollama pull ${OLLAMA_EMBED_MODEL}`
    );
    return null;
  },

  /**
   * Chat-capable models Ollama actually has, for the composer's model picker.
   * Embedding and vision models are excluded — picking one would produce
   * gibberish or an error rather than an answer.
   *
   * Cached because /api/tags is hit on every page load and the installed set
   * only changes when someone runs `ollama pull`.
   */
  async listChatModels() {
    const now = Date.now();
    if (modelCache && now - modelCache.at < MODEL_CACHE_MS) return modelCache.models;

    const response = await ollamaClient.get('/api/tags');
    const models = Array.isArray(response.data?.models) ? response.data.models : [];

    const usable = models
      .filter((m) => {
        const name = String(m.name || '');
        return name && !EXCLUDED_FROM_CHAT.some((bad) => name.startsWith(bad));
      })
      .map((m) => ({
        name: m.name,
        sizeGb: m.size ? Number((m.size / 1e9).toFixed(1)) : null,
        isDefault: m.name === OLLAMA_MODEL
      }))
      // Default first, then smallest — on CPU, size is the dominant cost.
      .sort((a, b) => Number(b.isDefault) - Number(a.isDefault) || (a.sizeGb || 0) - (b.sizeGb || 0));

    modelCache = { at: now, models: usable };
    return usable;
  },

  /**
   * Only ever send Ollama a model it has. An unknown name makes it try to pull
   * over the network, which on an offline machine hangs until the timeout.
   */
  async resolveModel(requested) {
    if (typeof requested !== 'string' || !requested.trim()) return undefined;
    const wanted = requested.trim();
    if (wanted === OLLAMA_MODEL) return undefined;

    const available = await module.exports.listChatModels();
    return available.some((m) => m.name === wanted) ? wanted : undefined;
  },

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
          // Must match request-time num_ctx, or the first real query pays a
          // full model reload and the warm-up was pointless.
          num_ctx: EFFECTIVE_NUM_CTX,
          temperature: 0
        }
      });

      console.log(`Ollama model "${OLLAMA_MODEL}" is warm and ready.`);
    } catch (error) {
      const normalizedError = normalizeOllamaError(error);
      console.warn(`Ollama warm-up skipped: ${normalizedError.message}`);
    }
  },

  // Retrieval now happens in the chat orchestrator, which passes any reference
  // material in via systemPrompt. This function only formats and sends.
  // `overrides` can raise num_ctx/num_predict for grounded answers, which need
  // far more context than a bare chat turn.
  async generateCompletion(model, prompt, systemPrompt = '', history = [], overrides = {}) {
    try {
      // Entries can arrive malformed from an API client; a null turn here used
      // to throw a TypeError and fail the whole request.
      // /api/chat with role-tagged messages, not a hand-built "Conversation So
      // Far:" string sent to /api/generate. The latter bypassed the model's own
      // chat template, which is what it was fine-tuned on — role tagging gives
      // noticeably better instruction-following and multi-turn coherence, and
      // a stable leading system message lets Ollama reuse its prefix KV cache.
      const messages = [];
      if (systemPrompt) messages.push({ role: 'system', content: systemPrompt });

      for (const turn of Array.isArray(history) ? history : []) {
        if (!turn || typeof turn !== 'object' || !turn.content) continue;
        messages.push({
          role: turn.role === 'assistant' ? 'assistant' : 'user',
          content: String(turn.content)
        });
      }
      messages.push({ role: 'user', content: prompt });

      const payload = {
        model: model || OLLAMA_MODEL,
        messages,
        stream: false,
        keep_alive: OLLAMA_KEEP_ALIVE,
        options: {
          num_predict: overrides.num_predict || OLLAMA_NUM_PREDICT,
          // Deliberately not overridable: a varying num_ctx forces model reloads.
          num_ctx: EFFECTIVE_NUM_CTX,
          num_thread: NUM_THREAD,
          temperature: overrides.temperature ?? 0.3,
          top_p: 0.9,
          // Stops the model looping on a phrase when an answer runs long.
          repeat_penalty: 1.1
        }
      };

      // `telemetry` carries what DevTools needs: the exact prompt sent, real
      // token counts from Ollama, and per-phase timings. Without it the UI can
      // only guess at cost, which defeats the point of an inspectable system.
      const telemetry = {
        model: payload.model,
        systemPrompt,
        messageCount: messages.length,
        numPredict: payload.options.num_predict,
        numCtx: payload.options.num_ctx
      };

      if (typeof overrides.onToken === 'function') {
        const streamed = await streamCompletion('/api/chat', payload, overrides.onToken, overrides.signal);
        return {
          response: streamed.text,
          telemetry: { ...telemetry, ...streamed.stats }
        };
      }

      const response = await ollamaClient.post('/api/chat', payload);
      const d = response.data || {};

      // Callers expect { response }; /api/chat returns { message: { content } }.
      return {
        response: d.message?.content || '',
        telemetry: {
          ...telemetry,
          promptTokens: d.prompt_eval_count,
          outputTokens: d.eval_count,
          promptMs: Math.round((d.prompt_eval_duration || 0) / 1e6),
          generateMs: Math.round((d.eval_duration || 0) / 1e6),
          loadMs: Math.round((d.load_duration || 0) / 1e6)
        }
      };

    } catch (error) {
      // A user pressing Stop is not a fault; logging it as one is misleading.
      if (isCancellation(error)) {
        const cancelled = new Error('Generation cancelled by the client');
        cancelled.cancelled = true;
        cancelled.statusCode = 499;
        throw cancelled;
      }

      const normalizedError = normalizeOllamaError(error);
      console.error(`Ollama Pipeline Core Error: ${normalizedError.message}`);
      throw normalizedError;
    }
  }
};
