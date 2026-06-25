const fs = require('fs/promises');
const path = require('path');

const PROJECT_ROOT = path.resolve(__dirname, '../../..');
const DB_FILE = process.env.DB_FILE
  ? path.resolve(PROJECT_ROOT, process.env.DB_FILE)
  : path.resolve(PROJECT_ROOT, 'storage/database.json');

const initialData = {
  chat_logs: []
};

async function ensureDatabase() {
  await fs.mkdir(path.dirname(DB_FILE), { recursive: true });

  try {
    await fs.access(DB_FILE);
  } catch {
    await fs.writeFile(DB_FILE, JSON.stringify(initialData, null, 2));
  }
}

async function readDatabase() {
  await ensureDatabase();
  const raw = await fs.readFile(DB_FILE, 'utf8');
  return raw.trim() ? JSON.parse(raw) : { ...initialData };
}

async function writeDatabase(data) {
  await ensureDatabase();
  await fs.writeFile(DB_FILE, JSON.stringify(data, null, 2));
}

async function checkDatabase() {
  const data = await readDatabase();
  return {
    connected: true,
    file: DB_FILE,
    chatLogCount: Array.isArray(data.chat_logs) ? data.chat_logs.length : 0
  };
}

async function insertChatLog({ prompt, response }) {
  const data = await readDatabase();

  if (!Array.isArray(data.chat_logs)) {
    data.chat_logs = [];
  }

  const record = {
    id: Date.now(),
    prompt,
    response,
    createdAt: new Date().toISOString()
  };

  data.chat_logs.push(record);
  await writeDatabase(data);

  return record;
}

module.exports = {
  DB_FILE,
  checkDatabase,
  insertChatLog
};
