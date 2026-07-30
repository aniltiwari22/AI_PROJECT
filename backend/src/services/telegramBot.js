const { processPrompt } = require('./chatEngine');

const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN || '';
const TELEGRAM_POLL_TIMEOUT_SECONDS = Number(process.env.TELEGRAM_POLL_TIMEOUT_SECONDS || 25);

/**
 * Telegram is a second way in, and it does not pass through the HTTP auth
 * middleware — it calls processPrompt directly. Without an allowlist, anyone
 * who finds the bot gets full access to the knowledge base, indexed code and
 * uploaded documents.
 *
 * Fails closed: with no allowlist configured the bot answers nobody, and logs
 * the chat id of whoever writes so it can be added deliberately.
 */
const ALLOWED_CHAT_IDS = new Set(
  (process.env.TELEGRAM_ALLOWED_CHAT_IDS || '')
    .split(',')
    .map((id) => id.trim())
    .filter(Boolean)
);

const announced = new Set();

function isAllowed(chatId) {
  const id = String(chatId);

  if (ALLOWED_CHAT_IDS.has(id)) return true;

  // Log each unknown chat once — repeated messages must not flood the console.
  if (!announced.has(id)) {
    announced.add(id);
    console.warn(
      ALLOWED_CHAT_IDS.size
        ? `Telegram: ignoring chat ${id} — not in TELEGRAM_ALLOWED_CHAT_IDS.`
        : `Telegram: ignoring chat ${id} — no allowlist set. ` +
          `To allow it: TELEGRAM_ALLOWED_CHAT_IDS=${id}`
    );
  }
  return false;
}
const TELEGRAM_REPLY_LIMIT = 3900;
const MAX_HISTORY_TURNS = Number(process.env.TELEGRAM_MAX_HISTORY_TURNS || 8); // user+assistant pairs kept per chat
const TYPING_REFRESH_MS = 4000; // Telegram typing indicator expires ~5s, so refresh it
const MAX_POLL_BACKOFF_MS = 30000;

let isRunning = false;
let lastUpdateId = 0;
let pollBackoffMs = 0;

// Per-chat state: conversation history + a promise chain so messages from the
// same chat are processed strictly in order (no interleaved/racy replies).
const chatHistories = new Map(); // chatId -> [{ role, content }]
const chatQueues = new Map();    // chatId -> Promise (tail of the processing chain)

function getTelegramStatus() {
  return {
    enabled: Boolean(TELEGRAM_BOT_TOKEN),
    running: isRunning,
    pollingTimeoutSeconds: TELEGRAM_POLL_TIMEOUT_SECONDS,
    activeChats: chatHistories.size
  };
}

function telegramUrl(method) {
  return `https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/${method}`;
}

async function callTelegram(method, payload, { retries = 2 } = {}) {
  let attempt = 0;
  let lastError;

  while (attempt <= retries) {
    try {
      const response = await fetch(telegramUrl(method), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload)
      });

      const body = await response.json().catch(() => ({}));

      if (!response.ok || body.ok === false) {
        // Telegram rate limiting: respect retry_after when present
        const retryAfter = body.parameters?.retry_after;
        if (retryAfter && attempt < retries) {
          await sleep(retryAfter * 1000);
          attempt += 1;
          continue;
        }
        throw new Error(body.description || `Telegram ${method} failed`);
      }

      return body.result;
    } catch (error) {
      lastError = error;
      attempt += 1;
      if (attempt <= retries) {
        await sleep(500 * attempt);
      }
    }
  }

  throw lastError;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// Splits on paragraph/line boundaries where possible instead of mid-word.
function chunkText(text, limit) {
  const safeText = String(text || 'No response.');
  if (safeText.length <= limit) return [safeText];

  const chunks = [];
  let remaining = safeText;

  while (remaining.length > limit) {
    let splitAt = remaining.lastIndexOf('\n', limit);
    if (splitAt < limit * 0.5) splitAt = remaining.lastIndexOf(' ', limit);
    if (splitAt < limit * 0.5) splitAt = limit;

    chunks.push(remaining.slice(0, splitAt));
    remaining = remaining.slice(splitAt).trimStart();
  }
  if (remaining) chunks.push(remaining);

  return chunks;
}

async function sendMessage(chatId, text) {
  const chunks = chunkText(text, TELEGRAM_REPLY_LIMIT);

  for (const chunk of chunks) {
    await callTelegram('sendMessage', {
      chat_id: chatId,
      text: chunk
    });
  }
}

// Telegram has no rich links in plain messages, so sources are appended as a
// short plain-text footer. Model-only answers get no footer.
function formatSources({ origin, sources }) {
  if (origin === 'web' && sources.length) {
    const links = sources.slice(0, 3).map((s, i) => `${i + 1}. ${s.title}\n   ${s.url}`);
    return `\n\n— Sources (web) —\n${links.join('\n')}`;
  }
  if (origin === 'internal' && sources.length) {
    const titles = [...new Set(sources.map((s) => s.title))].slice(0, 3);
    return `\n\n— From internal knowledge: ${titles.join(', ')}`;
  }
  return '';
}

function getHistory(chatId) {
  if (!chatHistories.has(chatId)) chatHistories.set(chatId, []);
  return chatHistories.get(chatId);
}

function pushToHistory(chatId, role, content) {
  const history = getHistory(chatId);
  history.push({ role, content });

  const maxEntries = MAX_HISTORY_TURNS * 2;
  if (history.length > maxEntries) {
    history.splice(0, history.length - maxEntries);
  }
}

// Keeps Telegram's "typing…" indicator alive for as long as processPrompt runs.
function startTypingLoop(chatId) {
  const tick = () => callTelegram('sendChatAction', { chat_id: chatId, action: 'typing' }).catch(() => {});
  tick();
  const interval = setInterval(tick, TYPING_REFRESH_MS);
  return () => clearInterval(interval);
}

async function handleMessage(message) {
  const chatId = message.chat?.id;
  const text = message.text?.trim();

  if (!chatId || !text) return;

  // Checked before any work is queued, so an unknown sender costs nothing —
  // no model call, no history entry, no reply that would confirm the bot runs.
  if (!isAllowed(chatId)) return;

  // Chain each chat's work onto its own queue so concurrent messages from the
  // same user never interleave or race on shared history.
  const previous = chatQueues.get(chatId) || Promise.resolve();
  const current = previous
    .catch(() => {}) // don't let one failure break the chain
    .then(() => processMessage(chatId, text));

  chatQueues.set(chatId, current);
  return current;
}

async function processMessage(chatId, text) {
  if (text === '/start' || text === '/help') {
    await sendMessage(
      chatId,
      'Hi! Send me a question and I will answer through Ashu Codex AI.\n\n' +
        'Commands:\n/reset - clear our conversation history\n/help - show this message'
    );
    return;
  }

  if (text === '/reset') {
    chatHistories.delete(chatId);
    await sendMessage(chatId, 'Conversation history cleared. Fresh start!');
    return;
  }

  const stopTyping = startTypingLoop(chatId);

  try {
    const history = getHistory(chatId);
    const result = await processPrompt(text, history);
    const responseText = result.answer;

    pushToHistory(chatId, 'user', text);
    pushToHistory(chatId, 'assistant', responseText);

    await sendMessage(chatId, responseText + formatSources(result));
  } catch (error) {
    console.error(`Telegram bot message failed (chat ${chatId}): ${error.message}`);
    await sendMessage(chatId, `Sorry, I could not answer that: ${error.message}`).catch(() => {});
  } finally {
    stopTyping();
  }
}

async function pollTelegram() {
  while (isRunning) {
    try {
      const updates = await callTelegram(
        'getUpdates',
        {
          offset: lastUpdateId + 1,
          timeout: TELEGRAM_POLL_TIMEOUT_SECONDS,
          allowed_updates: ['message']
        },
        { retries: 0 } // long-poll requests shouldn't be retried internally
      );

      pollBackoffMs = 0; // reset backoff after a successful poll

      for (const update of updates) {
        lastUpdateId = update.update_id;

        if (update.message) {
          // Fire-and-forget: don't block the polling loop on slow replies,
          // but still log unexpected failures.
          handleMessage(update.message).catch((error) =>
            console.error(`Unhandled message error: ${error.message}`)
          );
        }
      }
    } catch (error) {
      console.error(`Telegram bot polling failed: ${error.message}`);
      pollBackoffMs = Math.min(pollBackoffMs ? pollBackoffMs * 2 : 1000, MAX_POLL_BACKOFF_MS);
      await sleep(pollBackoffMs);
    }
  }
}

function startTelegramBot() {
  if (!TELEGRAM_BOT_TOKEN) {
    console.log('Telegram bot disabled. Set TELEGRAM_BOT_TOKEN to enable it.');
    return;
  }

  if (isRunning) return;

  isRunning = true;
  console.log('Telegram bot polling started.');
  pollTelegram();
}

function stopTelegramBot() {
  isRunning = false;
}

module.exports = {
  getTelegramStatus,
  startTelegramBot,
  stopTelegramBot
};
