import { prepareImage } from '../lib/image';

const API_BASE = import.meta.env.VITE_API_BASE_URL || 'http://localhost:5000/api/v1';

// /health sits at the server root, not under the versioned API prefix.
const HEALTH_URL = `${API_BASE.replace(/\/api\/v\d+\/?$/, '')}/health`;
const AUTH_BASE = `${API_BASE.replace(/\/v\d+\/?$/, '/v1')}/auth`;

// --- authentication ---------------------------------------------------------

const TOKEN_KEY = 'ashu-codex.token';

function readToken() {
  try {
    return localStorage.getItem(TOKEN_KEY) || '';
  } catch {
    return '';
  }
}

function writeToken(token) {
  try {
    if (token) localStorage.setItem(TOKEN_KEY, token);
    else localStorage.removeItem(TOKEN_KEY);
  } catch {
    /* storage disabled — the session lasts until reload */
  }
}

let token = readToken();
let onUnauthenticated = null;

/** The app registers this so a rejected token sends it back to the login screen. */
export function setUnauthenticatedHandler(fn) {
  onUnauthenticated = fn;
}

export function hasToken() {
  return Boolean(token);
}

export async function login(password) {
  try {
    const response = await fetch(`${AUTH_BASE}/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ password, label: 'web' })
    });
    const body = await response.json().catch(() => ({}));

    if (!response.ok || !body.success) {
      return { ok: false, error: body.error || `Sign-in failed (${response.status})` };
    }

    token = body.token;
    writeToken(token);
    return { ok: true, expiresAt: body.expiresAt };
  } catch (error) {
    return { ok: false, error: 'Cannot reach the backend' };
  }
}

export async function logout() {
  try {
    await fetch(`${AUTH_BASE}/logout`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}` }
    });
  } catch {
    /* revoking server-side is best effort; the local token goes regardless */
  }
  token = '';
  writeToken('');
}

/**
 * Every call goes through here so no request can forget the token, and so a
 * single 401 handler covers the whole app. A stored token that the server no
 * longer recognises — expired, or revoked from another device — clears itself.
 */
async function apiFetch(url, options = {}) {
  const headers = { ...(options.headers || {}) };
  if (token) headers.Authorization = `Bearer ${token}`;

  const response = await fetch(url, { ...options, headers });

  if (response.status === 401) {
    token = '';
    writeToken('');
    onUnauthenticated?.();
  }

  return response;
}

// Resolves to 'healthy' | 'degraded' | 'offline' so the header light reflects
// the backend's real state instead of being hardcoded green.
export async function fetchEngineHealth() {
  // Without a timeout a hung backend leaves this pending forever, and the 30s
  // poll keeps stacking new requests on top of it.
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 8000);

  try {
    const response = await apiFetch(HEALTH_URL, { signal: controller.signal });
    const body = await response.json().catch(() => ({}));
    return {
      status: body.status === 'healthy' ? 'healthy' : 'degraded',
      ollama: body.ollama,
      database: body.database,
      // Full payload drives the cockpit lamps and the health monitor page.
      raw: body
    };
  } catch {
    return { status: 'offline' };
  } finally {
    clearTimeout(timer);
  }
}

function readAsBase64(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    // result is a data: URL; the backend accepts either form.
    reader.onload = () => resolve(String(reader.result).replace(/^data:[^;]+;base64,/, ''));
    reader.onerror = () => reject(new Error('Could not read the file'));
    reader.readAsDataURL(file);
  });
}

// Uploads via base64 JSON (the backend has no multipart parser) and returns the
// extraction result, including any warning about unreadable content.
export async function uploadFile(file, { addToKnowledge = false } = {}) {
  try {
    // Images are downscaled first — vision cost is driven by pixel count, and
    // a full-resolution screenshot can take minutes on CPU.
    const prepared = await prepareImage(file);
    const payload = prepared.blob;
    const started = performance.now();

    const data = await readAsBase64(payload);

    const response = await apiFetch(`${API_BASE}/files`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        filename: file.name,
        // Re-encoded images are JPEG regardless of the original type.
        mimeType: prepared.resized ? 'image/jpeg' : file.type,
        data,
        addToKnowledge
      })
    });

    const body = await response.json().catch(() => ({}));
    if (!response.ok || !body.success) {
      throw new Error(body.error || `Upload failed (${response.status})`);
    }
    return {
      success: true,
      ...body,
      elapsedMs: Math.round(performance.now() - started),
      optimised: prepared.resized
        ? { from: prepared.from, to: prepared.to, pixelReduction: prepared.pixelReduction }
        : null
    };
  } catch (error) {
    return { success: false, error: error.message || 'Upload failed' };
  }
}

// Voice session tracking. Recognition and synthesis run in the browser, so
// these calls only record what happened — no audio leaves the page.
const VOICE_BASE = API_BASE.replace(/\/v\d+\/?$/, '/v2') + '/voice';

export async function createVoiceSession(language) {
  try {
    const response = await apiFetch(`${VOICE_BASE}/session`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ language })
    });
    const body = await response.json().catch(() => ({}));
    return body.sessionId || null;
  } catch {
    // Session tracking is optional — voice must still work without it.
    return null;
  }
}

export function logVoiceTurn(payload) {
  // Fire-and-forget: logging must never delay the spoken reply.
  apiFetch(`${VOICE_BASE}/turn`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload)
  }).catch(() => {});
}

// --- repository indexing (read-only on the server side) ---------------------

export async function fetchRepos() {
  try {
    const response = await apiFetch(`${API_BASE}/knowledge/repos`);
    const body = await response.json().catch(() => ({}));
    return Array.isArray(body.repos) ? body.repos : [];
  } catch {
    return [];
  }
}

export async function previewRepo(root) {
  try {
    const response = await apiFetch(`${API_BASE}/knowledge/repos/preview`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ root })
    });
    const body = await response.json().catch(() => ({}));
    if (!response.ok || !body.success) throw new Error(body.error || 'Could not read that folder');
    return body;
  } catch (error) {
    return { error: error.message };
  }
}

// Streams NDJSON progress: indexing takes minutes, and a silent request is
// indistinguishable from a hung one.
export async function indexRepo(root, { onProgress, signal } = {}) {
  try {
    const response = await apiFetch(`${API_BASE}/knowledge/repos`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      signal,
      body: JSON.stringify({ root })
    });

    if (!response.ok || !response.body) {
      const body = await response.json().catch(() => ({}));
      throw new Error(body.error || `Indexing failed (${response.status})`);
    }

    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    let summary = null;
    let failure = null;

    const handle = (line) => {
      const trimmed = line.trim();
      if (!trimmed) return;
      const event = JSON.parse(trimmed);
      if (event.progress) onProgress?.(event.progress);
      if (event.done) summary = event.done;
      if (event.error) failure = event.error;
    };

    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      let index;
      while ((index = buffer.indexOf('\n')) !== -1) {
        handle(buffer.slice(0, index));
        buffer = buffer.slice(index + 1);
      }
    }
    handle(buffer);

    if (failure) throw new Error(failure);
    return summary || { error: 'Indexing ended unexpectedly' };
  } catch (error) {
    if (error.name === 'AbortError') return { stopped: true };
    return { error: error.message };
  }
}

export async function removeRepo(root) {
  try {
    const response = await apiFetch(`${API_BASE}/knowledge/repos`, {
      method: 'DELETE',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ root })
    });
    const body = await response.json().catch(() => ({}));
    return Boolean(body.success);
  } catch {
    return false;
  }
}

// Live CPU and memory for the system monitor. Reports no GPU because there
// isn't one — the backend says so explicitly rather than sending a zero.
export async function fetchSystem() {
  try {
    const response = await apiFetch(`${API_BASE}/analytics/system`);
    if (!response.ok) return null;
    return await response.json();
  } catch {
    return null;
  }
}

// The most recently uploaded documents, for the dashboard's recent list.
export async function fetchRecentFiles(limit = 4) {
  try {
    const response = await apiFetch(`${API_BASE}/files`);
    const body = await response.json().catch(() => ({}));
    const files = Array.isArray(body.files) ? body.files : [];
    return [...files].reverse().slice(0, limit);
  } catch {
    return [];
  }
}

// Benchmark figures aggregated from the Excel request log.
export async function fetchAnalytics() {
  try {
    const response = await apiFetch(`${API_BASE}/analytics`);
    if (!response.ok) throw new Error(`Analytics unavailable (${response.status})`);
    return await response.json();
  } catch (error) {
    return { success: false, empty: true, error: error.message };
  }
}

// Chat-capable models Ollama has installed, for the composer's picker.
export async function fetchModels() {
  try {
    const response = await apiFetch(`${API_BASE}/chat/models`);
    const body = await response.json().catch(() => ({}));
    return { models: Array.isArray(body.models) ? body.models : [], default: body.default || '' };
  } catch {
    // The picker is an enhancement — without it the backend uses its default.
    return { models: [], default: '' };
  }
}

// `history` is the prior [{role, content}] turns, so the backend can answer
// follow-up questions in context. `fileIds` attaches uploaded documents.
// `model` overrides which model answers; the backend ignores unknown names.
export async function submitPromptToEngine(promptText, history = [], fileIds = [], handlers = {}) {
  const streaming = typeof handlers.onToken === 'function';
  let accumulated = '';

  try {
    const response = await apiFetch(`${API_BASE}/chat/query`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      signal: handlers.signal,
      body: JSON.stringify({
        prompt: promptText,
        history,
        fileIds,
        stream: streaming,
        model: handlers.model || undefined
      })
    });
    if (!response.ok) {
      const errorBody = await response.json().catch(() => ({}));
      throw new Error(errorBody.error || 'Network core bridge failure.');
    }

    // A backend that predates streaming ignores `stream` and answers with a
    // single JSON body; parsing that as NDJSON would fail, so trust the header.
    const isNdjson = (response.headers.get('content-type') || '').includes('ndjson');
    if (!streaming || !isNdjson || !response.body) return await response.json();

    // NDJSON: one JSON object per line — stage / token / reset / done / error.
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    let final = null;
    let streamError = null;

    const handleLine = (line) => {
      const trimmed = line.trim();
      if (!trimmed) return;

      const event = JSON.parse(trimmed);
      if (event.stage) handlers.onStage?.(event.stage);
      if (event.reset) {
        // A streamed attempt was rejected; drop it before the next one arrives.
        accumulated = '';
        handlers.onReset?.();
      }
      if (event.token) {
        accumulated += event.token;
        handlers.onToken(event.token, accumulated);
      }
      if (event.done) final = event.done;
      if (event.error) streamError = event.error;
    };

    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });

      let index;
      while ((index = buffer.indexOf('\n')) !== -1) {
        handleLine(buffer.slice(0, index));
        buffer = buffer.slice(index + 1);
      }
    }
    handleLine(buffer);

    if (streamError) throw new Error(streamError);
    if (!final) throw new Error('The response ended unexpectedly.');

    return { success: true, ...final };
  } catch (error) {
    // Stopping is a deliberate action, not a failure: keep whatever text had
    // already streamed rather than replacing it with an error.
    if (error.name === 'AbortError') {
      return { success: true, stopped: true, data: accumulated, origin: null, sources: [] };
    }

    console.error('[Service API Error]:', error);
    return {
      success: false,
      error: error.message || 'Failed connecting to Ashu Codex AI cluster.'
    };
  }
}

// --- conversations ----------------------------------------------------------

export async function fetchConversations() {
  try {
    const r = await apiFetch(`${API_BASE}/conversations`);
    const b = await r.json().catch(() => ({}));
    return Array.isArray(b.conversations) ? b.conversations : [];
  } catch {
    return [];
  }
}

export async function fetchConversation(id) {
  try {
    const r = await apiFetch(`${API_BASE}/conversations/${id}`);
    const b = await r.json().catch(() => ({}));
    return b.conversation || null;
  } catch {
    return null;
  }
}

export async function createConversation(title) {
  try {
    const r = await apiFetch(`${API_BASE}/conversations`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ title })
    });
    const b = await r.json().catch(() => ({}));
    return b.conversation || null;
  } catch {
    return null;
  }
}

// Fire-and-forget: persisting a turn must never delay showing it.
export function appendMessage(conversationId, message) {
  if (!conversationId) return;
  apiFetch(`${API_BASE}/conversations/${conversationId}/messages`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(message)
  }).catch(() => {});
}

export async function updateConversation(id, patch) {
  try {
    const r = await apiFetch(`${API_BASE}/conversations/${id}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(patch)
    });
    return (await r.json().catch(() => ({}))).success === true;
  } catch {
    return false;
  }
}

export async function deleteConversation(id) {
  try {
    const r = await apiFetch(`${API_BASE}/conversations/${id}`, { method: 'DELETE' });
    return (await r.json().catch(() => ({}))).success === true;
  } catch {
    return false;
  }
}

export async function searchConversations(query) {
  try {
    const r = await apiFetch(`${API_BASE}/conversations/search?q=${encodeURIComponent(query)}`);
    const b = await r.json().catch(() => ({}));
    return Array.isArray(b.results) ? b.results : [];
  } catch {
    return [];
  }
}

export async function fetchStorage() {
  try {
    const r = await apiFetch(`${API_BASE}/analytics/storage`);
    return await r.json();
  } catch {
    return null;
  }
}

export async function fetchModelInventory() {
  try {
    const r = await apiFetch(`${API_BASE}/analytics/models`);
    const b = await r.json().catch(() => ({}));
    return Array.isArray(b.models) ? b.models : [];
  } catch {
    return [];
  }
}

export async function explainRetrieval(query, topK = 8) {
  try {
    const r = await apiFetch(`${API_BASE}/knowledge/explain`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ query, topK })
    });
    const b = await r.json().catch(() => ({}));
    if (!r.ok || !b.success) throw new Error(b.error || `Failed (${r.status})`);
    return b;
  } catch (error) {
    return { error: error.message };
  }
}

export async function fetchKnowledge() {
  try {
    const r = await apiFetch(`${API_BASE}/knowledge`);
    return await r.json();
  } catch {
    return null;
  }
}

export async function deleteDocument(id) {
  try {
    const r = await apiFetch(`${API_BASE}/knowledge/${id}`, { method: 'DELETE' });
    return (await r.json().catch(() => ({}))).success === true;
  } catch {
    return false;
  }
}

// Background indexing progress for an upload. The upload itself returns as
// soon as the file is stored; embedding continues after.
export async function fetchIndexStatus(fileId) {
  try {
    const r = await apiFetch(`${API_BASE}/files/${fileId}/index`);
    const b = await r.json().catch(() => ({}));
    return b.job || null;
  } catch {
    return null;
  }
}

// Sheets an answer can be curated into, and the columns each one expects.
export async function fetchSheets() {
  try {
    const r = await apiFetch(`${API_BASE}/knowledge/sheets`);
    const b = await r.json().catch(() => ({}));
    return Array.isArray(b.sheets) ? b.sheets : [];
  } catch {
    return [];
  }
}

// Promotes an answer into the workbook, where it is returned with no model call.
export async function curateAnswer(sheet, values) {
  try {
    const r = await apiFetch(`${API_BASE}/knowledge/curate`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ sheet, values })
    });
    const b = await r.json().catch(() => ({}));
    if (!r.ok || !b.success) return { success: false, error: b.error || `Failed (${r.status})` };
    return b;
  } catch (error) {
    return { success: false, error: 'Cannot reach the backend' };
  }
}
