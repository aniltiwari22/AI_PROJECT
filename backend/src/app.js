const express = require('express');
const cors = require('cors');
const helmet = require('helmet');
const path = require('path');
require('dotenv').config({ path: path.resolve(__dirname, '../../.env') });

const chatRoutes = require('./routes/route1');
const authRoutes = require('./auth/routes');
const { checkDatabase } = require('./config/db');
const { checkOllama } = require('./config/ollama');
const { getTelegramStatus } = require('./services/telegramBot');
const { errorHandler } = require('./middleware/middleware1');

const app = express();

app.use(helmet());
app.use(cors({ origin: process.env.CORS_ORIGIN || '*' }));
app.use(express.json());

app.use('/api/v1/chat', chatRoutes);
app.use('/api/v1/auth', authRoutes);

app.get('/health', async (req, res) => {
  const health = {
    status: 'healthy',
    system: 'Ashu Codex AI Engine'
  };

  try {
    health.database = await checkDatabase();
  } catch (error) {
    health.status = 'degraded';
    health.database = {
      connected: false,
      error: error.message
    };
  }

  try {
    health.ollama = await checkOllama();
  } catch (error) {
    health.status = 'degraded';
    health.ollama = {
      connected: false,
      baseUrl: process.env.OLLAMA_BASE_URL || 'http://localhost:11434',
      error: error.message
    };
  }

  health.telegram = getTelegramStatus();

  res.status(health.status === 'healthy' ? 200 : 503).json(health);
});

app.use(errorHandler);

module.exports = app;
