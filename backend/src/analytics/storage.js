const fs = require('fs');
const fsp = require('fs/promises');
const path = require('path');
const os = require('os');
const sqlite = require('../storage/sqlite');

/**
 * Where disk actually goes, measured rather than assumed.
 *
 * The categories are the ones this app is responsible for. Anything it did not
 * put on disk is reported as "other" rather than being broken down, because
 * guessing at the rest of the drive would be inventing numbers.
 */

const PROJECT_ROOT = path.resolve(__dirname, '../../..');

async function directorySize(dir) {
  let total = 0;
  const queue = [dir];

  while (queue.length) {
    const current = queue.shift();
    let entries;
    try {
      entries = await fsp.readdir(current, { withFileTypes: true });
    } catch {
      continue; // unreadable or removed mid-walk
    }
    for (const entry of entries) {
      const full = path.join(current, entry.name);
      if (entry.isDirectory()) {
        queue.push(full);
      } else if (entry.isFile()) {
        try {
          total += (await fsp.stat(full)).size;
        } catch {
          /* vanished */
        }
      }
    }
  }
  return total;
}

/** Ollama keeps its blobs outside the project; find them without guessing. */
function ollamaModelsDir() {
  if (process.env.OLLAMA_MODELS) return process.env.OLLAMA_MODELS;
  return path.join(os.homedir(), '.ollama', 'models');
}

let cache = null;
let cachedAt = 0;
// Walking the model directory costs real I/O and the answer barely moves.
const CACHE_MS = Number(process.env.STORAGE_CACHE_MS || 60_000);

async function storageBreakdown() {
  if (cache && Date.now() - cachedAt < CACHE_MS) return cache;

  const [database, documents, models, logs] = await Promise.all([
    fsp.stat(sqlite.DB_FILE).then((s) => s.size).catch(() => 0),
    directorySize(path.join(PROJECT_ROOT, 'storage')),
    directorySize(ollamaModelsDir()),
    directorySize(path.join(PROJECT_ROOT, 'logs'))
  ]);

  // storage/ contains the database file too; don't count it twice.
  const documentsOnly = Math.max(0, documents - database);

  const categories = [
    { key: 'models', label: 'Models', bytes: models },
    { key: 'documents', label: 'Documents', bytes: documentsOnly },
    { key: 'database', label: 'Database', bytes: database },
    { key: 'logs', label: 'Logs', bytes: logs }
  ];

  const used = categories.reduce((n, c) => n + c.bytes, 0);

  cache = {
    categories,
    usedBytes: used,
    // Total drive capacity is not something Node reports portably, so it is
    // omitted rather than filled with a plausible-looking number.
    modelsPath: ollamaModelsDir(),
    projectPath: PROJECT_ROOT
  };
  cachedAt = Date.now();
  return cache;
}

/** Models Ollama has, with the sizes it reports and which are resident now. */
async function modelInventory() {
  const { listChatModels } = require('../config/ollama');
  const axios = require('axios');
  const base = process.env.OLLAMA_BASE_URL || 'http://localhost:11434';

  const [installed, loaded] = await Promise.all([
    listChatModels().catch(() => []),
    axios.get(`${base}/api/ps`, { timeout: 5000 }).then((r) => r.data?.models || []).catch(() => [])
  ]);

  const residentByName = new Map(loaded.map((m) => [m.name, m]));

  return installed.map((m) => {
    const resident = residentByName.get(m.name);
    return {
      name: m.name,
      sizeGb: m.sizeGb,
      isDefault: m.isDefault,
      loaded: Boolean(resident),
      // Ollama unloads on a timer; the UI can show how long is left.
      expiresAt: resident?.expires_at || null
    };
  });
}

module.exports = { storageBreakdown, modelInventory, directorySize };
