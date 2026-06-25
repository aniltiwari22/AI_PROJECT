const path = require('path');
require('dotenv').config({ path: path.resolve(__dirname, '../../.env') });

const app = require('./app');
const { warmupOllama } = require('./config/ollama');
const { startTelegramBot, stopTelegramBot } = require('./services/telegramBot');

const PORT = process.env.PORT || 5000;

const server = app.listen(PORT, () => {
  console.log(`Ashu Codex AI Core operating on port ${PORT}`);
  warmupOllama();
  startTelegramBot();
});

server.on('error', (error) => {
  if (error.code === 'EADDRINUSE') {
    console.error(`Port ${PORT} is already in use. Set PORT to another value or stop the existing process.`);
    process.exit(1);
  }

  throw error;
});

module.exports = server;

process.on('SIGINT', () => {
  stopTelegramBot();
  server.close(() => process.exit(0));
});

process.on('SIGTERM', () => {
  stopTelegramBot();
  server.close(() => process.exit(0));
});
