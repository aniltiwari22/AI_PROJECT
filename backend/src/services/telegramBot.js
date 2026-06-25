const { processPrompt } = require('./chatEngine');

const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN || '';
const TELEGRAM_POLL_TIMEOUT_SECONDS = Number(process.env.TELEGRAM_POLL_TIMEOUT_SECONDS || 25);
const TELEGRAM_REPLY_LIMIT = 3900;

let isRunning = false;
let lastUpdateId = 0;

function getTelegramStatus() {
  return {
    enabled: Boolean(TELEGRAM_BOT_TOKEN),
    running: isRunning,
    pollingTimeoutSeconds: TELEGRAM_POLL_TIMEOUT_SECONDS
  };
}

function telegramUrl(method) {
  return `https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/${method}`;
}

async function callTelegram(method, payload) {
  const response = await fetch(telegramUrl(method), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload)
  });

  const body = await response.json().catch(() => ({}));

  if (!response.ok || body.ok === false) {
    throw new Error(body.description || `Telegram ${method} failed`);
  }

  return body.result;
}

async function sendMessage(chatId, text) {
  const chunks = String(text || 'No response.').match(new RegExp(`[\\s\\S]{1,${TELEGRAM_REPLY_LIMIT}}`, 'g')) || ['No response.'];

  for (const chunk of chunks) {
    await callTelegram('sendMessage', {
      chat_id: chatId,
      text: chunk
    });
  }
}

async function handleMessage(message) {
  const chatId = message.chat?.id;
  const text = message.text?.trim();

  if (!chatId || !text) {
    return;
  }

  if (text === '/start' || text === '/help') {
    await sendMessage(chatId, 'Hi! Send me a question and I will answer through Ashu Codex AI.');
    return;
  }

  try {
    await callTelegram('sendChatAction', {
      chat_id: chatId,
      action: 'typing'
    });

    const responseText = await processPrompt(text);
    await sendMessage(chatId, responseText);
  } catch (error) {
    console.error(`Telegram bot message failed: ${error.message}`);
    await sendMessage(chatId, `Sorry, I could not answer that: ${error.message}`);
  }
}

async function pollTelegram() {
  while (isRunning) {
    try {
      const updates = await callTelegram('getUpdates', {
        offset: lastUpdateId + 1,
        timeout: TELEGRAM_POLL_TIMEOUT_SECONDS,
        allowed_updates: ['message']
      });

      for (const update of updates) {
        lastUpdateId = update.update_id;

        if (update.message) {
          await handleMessage(update.message);
        }
      }
    } catch (error) {
      console.error(`Telegram bot polling failed: ${error.message}`);
      await new Promise((resolve) => setTimeout(resolve, 5000));
    }
  }
}

function startTelegramBot() {
  if (!TELEGRAM_BOT_TOKEN) {
    console.log('Telegram bot disabled. Set TELEGRAM_BOT_TOKEN to enable it.');
    return;
  }

  if (isRunning) {
    return;
  }

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
