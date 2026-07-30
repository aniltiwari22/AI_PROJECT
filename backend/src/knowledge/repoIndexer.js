const fs = require('fs');
const fsp = require('fs/promises');
const path = require('path');
const vectorStore = require('./vectorStore');
const { CODE_EXTENSIONS } = require('./chunker');
const sqlite = require('../storage/sqlite');

/**
 * Indexes a folder of source files so questions can be answered from a whole
 * project rather than from one uploaded file at a time.
 *
 * Read-only: this walks and reads: it never writes to the folder it indexes.
 *
 * Only worth doing now that storage is SQLite. A real repository produces
 * thousands of chunks, each carrying a 768-float embedding; as JSON that was
 * projected at 76.8MB for 5,000 chunks against 15.4MB as packed blobs, and
 * every single write rewrote the entire file.
 */

// Directories that are never source. Walking node_modules would index tens of
// thousands of files nobody asked about and take hours of embedding time.
const SKIP_DIRS = new Set([
  'node_modules', '.git', '.svn', '.hg', 'dist', 'build', 'out', 'target',
  '.next', '.nuxt', '.cache', 'coverage', '__pycache__', '.venv', 'venv',
  'env', '.idea', '.vscode', 'vendor', 'bower_components', '.pytest_cache',
  'storage', 'logs'
]);

const EXTRA_EXTENSIONS = new Set(['md', 'markdown', 'json', 'yml', 'yaml', 'txt']);
const BARE_FILENAMES = new Set(['dockerfile', 'makefile', 'rakefile', 'gemfile', 'procfile']);

// Past this a file is almost certainly generated, minified or data.
const MAX_FILE_BYTES = Number(process.env.REPO_MAX_FILE_BYTES || 256 * 1024);
const MAX_FILES = Number(process.env.REPO_MAX_FILES || 400);

const PROJECT_ROOT = path.resolve(__dirname, '../../..');

/**
 * Relative paths resolve against the project root, not the server's working
 * directory. The server runs from backend/, so "backend/src" resolved to
 * backend/backend/src and reported a folder that does not exist — every other
 * path setting in this app is project-root relative, and this now matches.
 */
function resolveRoot(root) {
  const raw = String(root || '').trim();
  return path.isAbsolute(raw) ? path.resolve(raw) : path.resolve(PROJECT_ROOT, raw);
}

/**
 * Folders the indexer is permitted to read. Defaults to the project itself.
 *
 * Without this, any caller could index an arbitrary path and then query its
 * contents — `{"root": "C:/Users/M3084/Documents"}` returned a readable file
 * listing. Authentication now blocks anonymous callers, but a stolen session
 * should still not be able to read the whole drive, so the reachable area is
 * bounded independently.
 *
 * Set REPO_ALLOWED_ROOTS to a path-separator-delimited list to widen it.
 */
function allowedRoots() {
  const configured = (process.env.REPO_ALLOWED_ROOTS || '')
    .split(path.delimiter)
    .map((p) => p.trim())
    .filter(Boolean)
    .map((p) => path.resolve(p));

  return configured.length ? configured : [PROJECT_ROOT];
}

/** True when `target` is inside `parent` — not merely prefixed by its name. */
function isInside(parent, target) {
  const relative = path.relative(parent, target);
  // '' means the folder itself. A leading '..' means it escaped. isAbsolute
  // catches a different drive on Windows, where relative() returns 'D:\...'.
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
}

function assertAllowed(resolved) {
  const roots = allowedRoots();
  if (roots.some((root) => isInside(root, resolved))) return;

  const error = new Error(
    `That folder is outside the allowed area. Permitted: ${roots.join(', ')}. ` +
    'Set REPO_ALLOWED_ROOTS to index somewhere else.'
  );
  error.statusCode = 403;
  throw error;
}

function isIndexable(filename) {
  const lower = filename.toLowerCase();
  if (BARE_FILENAMES.has(lower)) return true;

  const ext = (lower.match(/\.([a-z0-9]+)$/) || [])[1];
  if (!ext) return false;
  if (lower.endsWith('.min.js') || lower.endsWith('.min.css')) return false;

  return CODE_EXTENSIONS.has(ext) || EXTRA_EXTENSIONS.has(ext);
}

/** Binary files read as text produce garbage embeddings, so they are skipped. */
function looksBinary(buffer) {
  const window = buffer.subarray(0, Math.min(buffer.length, 1024));
  for (const byte of window) if (byte === 0) return true;
  return false;
}

async function walk(root, { maxFiles = MAX_FILES } = {}) {
  const found = [];
  const skipped = { tooBig: 0, binary: 0, notSource: 0 };
  const queue = [root];

  while (queue.length && found.length < maxFiles) {
    const dir = queue.shift();
    let entries;
    try {
      entries = await fsp.readdir(dir, { withFileTypes: true });
    } catch {
      continue; // unreadable directory — permissions, or removed mid-walk
    }

    for (const entry of entries) {
      if (found.length >= maxFiles) break;
      const full = path.join(dir, entry.name);

      if (entry.isDirectory()) {
        if (!SKIP_DIRS.has(entry.name) && !entry.name.startsWith('.')) queue.push(full);
        continue;
      }
      if (!entry.isFile()) continue;

      if (!isIndexable(entry.name)) { skipped.notSource += 1; continue; }

      let stat;
      try { stat = await fsp.stat(full); } catch { continue; }
      if (stat.size > MAX_FILE_BYTES) { skipped.tooBig += 1; continue; }
      if (stat.size === 0) continue;

      found.push({ path: full, relative: path.relative(root, full), bytes: stat.size });
    }
  }

  return { files: found, skipped, truncated: found.length >= maxFiles };
}

/**
 * Indexes every source file under `root`.
 *
 * @param onProgress called per file so the caller can stream progress — on CPU
 *        this takes minutes and silence looks like a hang.
 */
async function indexRepo(root, { onProgress, signal, maxFiles } = {}) {
  const resolved = resolveRoot(root);
  assertAllowed(resolved);

  if (!fs.existsSync(resolved)) {
    const error = new Error(`No such folder: ${resolved}`);
    error.statusCode = 400;
    throw error;
  }
  if (!fs.statSync(resolved).isDirectory()) {
    const error = new Error(`Not a folder: ${resolved}`);
    error.statusCode = 400;
    throw error;
  }

  const { files, skipped, truncated } = await walk(resolved, { maxFiles });
  const repoName = path.basename(resolved);
  const sourceTag = `repo:${resolved}`;

  // Re-indexing replaces the previous snapshot rather than stacking a second
  // copy of every file on top of it.
  const removed = await removeRepo(resolved);

  const indexed = [];
  const failed = [];

  for (let i = 0; i < files.length; i += 1) {
    if (signal?.aborted) break;
    const file = files[i];

    try {
      const buffer = await fsp.readFile(file.path);
      if (looksBinary(buffer)) { skipped.binary += 1; continue; }

      const text = buffer.toString('utf8');
      if (!text.trim()) continue;

      // The title is the repo-relative path, so citations read
      // "backend/src/config/db.js:14-22" and the chunker sees the extension.
      const result = await vectorStore.addDocument({
        title: file.relative.replace(/\\/g, '/'),
        source: sourceTag,
        text
      });

      indexed.push({ file: file.relative, chunks: result.chunks });
      onProgress?.({ done: i + 1, total: files.length, file: file.relative, chunks: result.chunks });
    } catch (error) {
      failed.push({ file: file.relative, error: error.message });
    }
  }

  return {
    root: resolved,
    name: repoName,
    files: indexed.length,
    chunks: indexed.reduce((n, f) => n + f.chunks, 0),
    replaced: removed.documents,
    skipped,
    failed,
    truncated,
    stopped: Boolean(signal?.aborted)
  };
}

/** Drops everything previously indexed from this folder. */
async function removeRepo(root) {
  const sourceTag = `repo:${resolveRoot(root)}`;
  const result = sqlite.stmt('DELETE FROM documents WHERE source = ?').run(sourceTag);
  return { documents: result.changes };
}

/** Which folders are currently indexed, and how much of each. */
async function listRepos() {
  return sqlite
    .stmt(`SELECT source, COUNT(*) AS files, SUM(chunk_count) AS chunks, MAX(created_at) AS indexedAt
           FROM documents WHERE source LIKE 'repo:%'
           GROUP BY source ORDER BY indexedAt DESC`)
    .all()
    .map((row) => ({
      root: row.source.slice('repo:'.length),
      name: path.basename(row.source.slice('repo:'.length)),
      files: row.files,
      chunks: row.chunks,
      indexedAt: row.indexedAt
    }));
}

/** A dry run, so the cost is known before committing minutes of embedding. */
async function previewRepo(root, { maxFiles } = {}) {
  const resolved = resolveRoot(root);
  assertAllowed(resolved);

  if (!fs.existsSync(resolved) || !fs.statSync(resolved).isDirectory()) {
    const error = new Error(`No such folder: ${resolved}`);
    error.statusCode = 400;
    throw error;
  }

  const { files, skipped, truncated } = await walk(resolved, { maxFiles });
  const bytes = files.reduce((n, f) => n + f.bytes, 0);

  return {
    root: resolved,
    name: path.basename(resolved),
    files: files.length,
    bytes,
    // ~4 chars per token, and embedding runs at roughly 250 chunks/minute here.
    estimatedChunks: Math.ceil(bytes / 1400),
    truncated,
    skipped,
    sample: files.slice(0, 10).map((f) => f.relative.replace(/\\/g, '/'))
  };
}

module.exports = {
  indexRepo, removeRepo, listRepos, previewRepo, walk, isIndexable,
  SKIP_DIRS, allowedRoots, isInside, assertAllowed
};
