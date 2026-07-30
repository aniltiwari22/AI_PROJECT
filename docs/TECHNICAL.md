# Ashu Codex AI — Technical Reference

**Version 2.1** · local-first AI assistant · Node.js + React + Ollama + SQLite

A private assistant that runs entirely on one machine. No request leaves the
host except an optional web search. It answers from curated Excel rows, a
cached-answer store, an indexed codebase, uploaded documents, the model's own
knowledge, or the web — in that order of preference — and reports which one it
used with a confidence score.

---

## 1. Architecture

```
┌─────────────────────────────────────────────────────────────────┐
│  Browser (React 18 + Vite + Tailwind)                           │
│    Dashboard · Chat · Context rail · DevTools · Health · Bench   │
│    Web Speech API for voice (STT + TTS, in-browser)              │
└──────────────────────────┬──────────────────────────────────────┘
                           │  JSON / NDJSON over HTTP
┌──────────────────────────▼──────────────────────────────────────┐
│  Express backend                                                │
│    controller1 ──► chatEngine (retrieval orchestrator)          │
│                      ├── excelStore      knowledge.xlsx         │
│                      ├── semanticCache   embeddings, cosine     │
│                      ├── vectorStore     chunks + FTS5          │
│                      ├── fileStore       uploaded documents     │
│                      └── webSearch       Tavily (optional)      │
│    repoIndexer · chunker · analytics · voice · logging          │
└───────────┬───────────────────────────────┬─────────────────────┘
            │                               │
    ┌───────▼────────┐             ┌────────▼─────────┐
    │  Ollama :11434 │             │ SQLite ashu.db   │
    │  chat · vision │             │ WAL · FTS5       │
    │  embeddings    │             └──────────────────┘
    └────────────────┘
```

**Scale:** 31 backend modules (4,661 lines), 23 frontend modules (3,599 lines),
156 tests.

### Process model

Single Node process, single SQLite file, single Ollama daemon. No queue, no
worker pool, no external database. `better-sqlite3` is synchronous, so store
functions are `async` only to preserve the call signatures their callers
already used — there is no I/O concurrency to manage inside them.

---

## 2. The retrieval pipeline

The core of the system. `services/chatEngine.js::processPrompt` escalates
through sources, stopping at the first that answers well enough. Each step is
timed and streamed to the UI as a structured event.

| Order | Step | Source | Confidence | Stops when |
|---|---|---|---|---|
| 0 | greeting | pattern match | 1.00 | prompt is a bare greeting (~10 ms) |
| 1 | file | attached upload | 0.97 | a file is attached to the turn |
| 2 | excel | `knowledge.xlsx` | 1.00 | identifier or question matches a row |
| 3 | cache | `cache` table | 0.93 | cosine similarity ≥ 0.95 |
| 4 | internal | `chunks` table | 0.90 | relevance passes `retrievalPolicy` |
| 5 | model | Ollama | 0.60 | the model does not disclaim ignorance |
| 6 | web | Tavily | 0.78 | search is enabled and returns results |

Curated Excel rows outrank everything because a human wrote them for that exact
question. Model knowledge is lowest because nothing verifies it.

### Escalation rules

`services/retrievalPolicy.js` decides whether an internal match is strong
enough, using different thresholds for embedding scores and keyword scores —
the two are not comparable. Two overrides matter:

- **Temporal questions** ("latest", "current", a year) skip step 5 entirely.
  The model's training data is guaranteed stale, so asking it first wastes a
  full generation before escalating anyway.
- **Self-declared ignorance** — if the model answers with "I don't have
  information about…", that is treated as a miss and the pipeline escalates to
  web search. A `reset` event tells the client to discard what already streamed.

### Grounding

When reference material is present, the system prompt gains `GROUNDED_RULES`,
which exist because of a specific failure: with a small context window the
model silently ignored retrieved web results and answered from training weights
("as of my last update… 18.20.8"). The rules state that the reference material
is authoritative, that it overrides the model's memory, and that
"as of my last update" is never an acceptable answer.

---

## 3. Storage

One SQLite database, `storage/ashu.db`, in WAL mode with
`synchronous = NORMAL` and foreign keys enforced.

| Table | Holds |
|---|---|
| `chat_logs` | every prompt and response |
| `files` | uploaded documents, including extracted text |
| `documents` | one row per ingested file or knowledge entry |
| `chunks` | retrievable passages, embedding as BLOB, optional line range |
| `chunks_fts` | FTS5 index over `chunks.text`, synced by three triggers |
| `cache` | semantic cache: question, answer, embedding, hits, LRU timestamp |
| `request_logs` | per-request telemetry for the Benchmark view |
| `voice_logs` | voice turns: transcript, language, spoken, interrupted |

### Embeddings

768 float32s per chunk. Stored as a packed `Buffer`
(`sqlite.packEmbedding` / `unpackEmbedding`), which is **3 KB per row against
15.4 KB as JSON text** — and needs no parsing on read.

> `unpackEmbedding` copies the blob before constructing the `Float32Array`.
> Node pools small Buffers, so a view over the shared pool would read adjacent
> data.

### Why not JSON files

The previous design was four JSON files, each rewritten in full on every write:

- Appending one 200-byte chat log rewrote 136 KB.
- The cache cost 15.4 KB per entry; at its 500-entry cap a single new answer
  meant re-reading and re-writing **7.5 MB**.
- Concurrent writes lost data silently — measured at 24 of 25 lost before a
  write queue was added.
- A crash mid-write truncated the file and took everything with it.

Real data: 445 KB across four JSON files became 284 KB in one database, 36%
smaller, with per-row writes and real transactions.

### Migration

`node src/storage/migrate.js` imports the legacy JSON files and both log
workbooks. It is **non-destructive** (sources are read, never modified) and
**idempotent** (rows match on natural keys, so a second run imports nothing).
`--check` reports what would be imported without writing.

### Excel is still Excel

`storage/knowledge.xlsx` stays a workbook because a person edits it by hand —
six sheets (FAQs, APIs, Errors, SQL, Jira, Emails), identifier-first matching,
mtime-cached. The two **log** workbooks are generated from the database on
demand instead of being written live:

```bash
curl -X POST http://localhost:5000/api/v1/analytics/export \
  -H "Content-Type: application/json" -d '{"which":"all"}'
```

---

## 4. Chunking

`knowledge/chunker.js` routes by content type, because prose and code need
opposite treatment.

**Prose** — 180-word windows with 30-word overlap.

**Code** — split on declaration boundaries, formatting preserved, line range
recorded. Detected by extension, or by punctuation density and indentation
when there is no filename.

The word-window splitter was applied to everything, and it destroyed code
before it was ever embedded:

```
function pack(v) { if (!Array.isArray(v)) return null; return Buffer.from(v); }
```

Every newline and indent gone — that is what got embedded, and what the model
quoted back. It also cut through functions: 2 of 5 chunks from a real 183-line
file had unbalanced braces. After the rewrite: **0 unbalanced, formatting
intact, and citations that read `semanticCache.js:70-105`.**

A leading comment block travels with the declaration it describes, since that
is usually where the intent is. A unit larger than the budget splits on line
boundaries, never mid-line.

### Path-anchored embeddings

The string that gets **embedded** is not the string that gets **stored**.
Questions name paths and concepts ("the semantic cache eviction") while a code
body contains neither — identifiers are split across camelCase and the words
live in the file path. So the path, split into words, is prefixed to the text
before embedding; the stored text stays clean.

Measured on this codebase, top-1 file retrieval went **3/5 → 4/5**.

---

## 5. Repository indexing

`knowledge/repoIndexer.js`. **Read-only** — it walks and reads, and never
writes to the folder it indexes.

- `previewRepo` is a dry run reporting file count, bytes and estimated chunks,
  so the cost is visible before minutes of embedding are spent.
- `indexRepo` streams NDJSON progress per file; on this hardware a repo takes
  minutes and silence is indistinguishable from a hang.
- Re-indexing replaces the previous snapshot rather than stacking a duplicate.
- Skips `node_modules`, `.git`, `dist`, `build`, dotfiles, binaries (NUL-byte
  sniff), minified files, and anything over `REPO_MAX_FILE_BYTES`.
- Relative paths resolve against the **project root**, not the server's working
  directory — the server runs from `backend/`, so `backend/src` used to resolve
  to `backend/backend/src`.

Measured: 34 files → 141 chunks in 110 s (~20 files/minute).

Only viable because storage is SQLite. At 5,000 chunks the JSON design was
projected at 76.8 MB against 15.4 MB of packed blobs, with every write
rewriting the whole file.

---

## 6. Ollama integration

`config/ollama.js` talks to `/api/chat` with role-tagged messages rather than a
hand-built "Conversation So Far:" string sent to `/api/generate`. The latter
bypassed the model's own chat template, which is what it was fine-tuned on.

### Context size is global

`EFFECTIVE_NUM_CTX = max(OLLAMA_NUM_CTX, GROUNDED_NUM_CTX)` and every request
uses it. Varying `num_ctx` between requests forces Ollama to reload the model —
measured at **87–168 s per switch**. Only `num_predict` varies per request.

### Model selection

`GET /api/v1/chat/models` lists chat-capable models, excluding embedding models
that would return gibberish if selected. `resolveModel` validates any requested
name against what Ollama actually has — an unknown name makes Ollama attempt a
network pull, which hangs on an offline machine.

Selection is a **sticky manual choice**, not per-question routing, because
switching is expensive (§8).

### Vision

`describeImage` uses `qwen2.5vl:7b` with `VISION_KEEP_ALIVE=0`. The client
downscales images against a pixel budget first (`lib/image.js`) — vision cost
is driven by pixel count, and a full-resolution screenshot took minutes.

### Embeddings

`nomic-embed-text`, with a graceful cascade: if no embedding model is
available, `embedDisabled` latches and retrieval falls back to FTS5 keyword
search. Semantic cache lookups are skipped entirely rather than degrading to
exact string match, which would be misleading.

---

## 7. API reference

### Chat

```
POST /api/v1/chat/query
  { prompt, history?, fileIds?, stream?, model? }
```

`prompt` must be a non-empty **string**. A truthy non-string used to reach the
model as `"[object Object]"` and cost a full generation.

With `stream: true`, responds `application/x-ndjson`, one object per line:

| Event | Meaning |
|---|---|
| `{"stage":{key,label,status,ms}}` | pipeline step began or finished |
| `{"token":"…"}` | incremental answer text |
| `{"reset":true}` | discard streamed text; another attempt follows |
| `{"done":{data,origin,confidence,sources,trace,timeline,telemetry}}` | final |
| `{"error":"…"}` | failure after streaming began |

```
GET  /api/v1/chat/models
```

### Knowledge and repositories

```
GET    /api/v1/knowledge              list documents + store stats
POST   /api/v1/knowledge              { title?, source?, text }
POST   /api/v1/knowledge/search       { query, topK? }  — inspect retrieval
DELETE /api/v1/knowledge/:id
GET    /api/v1/knowledge/repos        indexed folders
POST   /api/v1/knowledge/repos/preview  { root }  — dry run
POST   /api/v1/knowledge/repos        { root }    — index, NDJSON progress
DELETE /api/v1/knowledge/repos        { root }
```

### Files

```
POST   /api/v1/files    { filename, mimeType?, data, addToKnowledge? }
GET    /api/v1/files
DELETE /api/v1/files/:id
```

Base64 JSON, not multipart. `data` is validated as base64 before decoding —
`Buffer.from(x, 'base64')` never throws, it silently discards invalid
characters, so a corrupt upload used to be stored as a few bytes of garbage and
reported as success.

Accepts PDF, DOCX, PPTX, images, plain text and **39 source-code extensions**
(`extract.js::CODE_TYPES`). Note this is a wider set than the chunker's
`CODE_EXTENSIONS` (30), which decides whether to chunk *as code*: config
formats like `.ini` and `.env` upload as text but are split as prose, having no
declarations to split on.

Extraction is dependency-free: PDF via zlib inflate of FlateDecode streams with
subset-font offset repair; DOCX via ZIP central directory + `inflateRawSync`.

### Analytics, voice, health

```
GET  /api/v1/analytics          aggregated benchmark figures (SQL)
GET  /api/v1/analytics/system   live CPU / RAM
POST /api/v1/analytics/export   { which: "requests" | "voice" | "all" }
POST /api/v2/voice/session      { language }
POST /api/v2/voice/turn         records a completed turn
GET  /api/v2/voice/history
GET  /health                    per-subsystem status
```

Unmatched `/api/*` routes return JSON, not Express's default HTML page — a
client calling `response.json()` on that fails with `Unexpected token <`
instead of showing the real problem.

---

## 8. Performance

Measured on this machine: 8 CPU cores, 16 GB RAM, **no discrete GPU** — Ollama
runs on the CPU. These numbers dominate every design decision above.

### Prompt evaluation is the bottleneck

Identical input, two small source files (10 KB, ~2,600 tokens), one-sentence
question:

| | qwen2.5-coder:7b | deepseek-coder:1.3b |
|---|---|---|
| Reading the prompt | 15.8 tok/s → **164 s** | 64.8 tok/s → **59 s** |
| Generating | 3.5 tok/s | 6.8 tok/s |
| **Total** | **183 s** | **72 s** |

Reading two small files takes the 7B model nearly three minutes before it
generates a single token. This is why retrieval sends 2–3 relevant functions
rather than whole files.

### Model switching is brutal

Same question, `Array.prototype.flat`:

| | Wall |
|---|---|
| deepseek, cold after a switch | **378 s** |
| deepseek, warm | **7 s** |
| qwen, warm | 23 s |

Warm, the 1.3B model is ~3.3× faster. The switch itself costs more than either
answer. Hence a sticky manual picker rather than automatic routing — and
deepseek's answer was also wrong where qwen's was right, so speed is a
trade-off, not a free win.

### Live figures

From 63 logged requests: median **1.29 s**, **52.4%** answered without
invoking a model at all.

| Origin | Count | Median |
|---|---|---|
| model | 25 | 24.06 s |
| cache | 17 | **0.13 s** |
| greeting | 16 | 0.03 s |
| internal | 2 | 90.54 s |
| web | 2 | 98.92 s |
| file | 1 | 89.53 s |

A cache hit is roughly **180× faster** than a fresh generation. That is what the
semantic cache buys.

---

## 9. Frontend

React 18, Vite, Tailwind driven by CSS variables so light and dark share one
set of semantic names (`--surface`, `--accent`, `--content`) and no component
hardcodes a palette.

| Area | Components |
|---|---|
| Shell | `App.jsx`, `TopBar`, `Dashboard`, `SystemView` |
| Chat | `ChatComponent1`, `CodeBlock`, `DiffBlock`, `SourceList`, `MessageCost` |
| Context | `ContextRail`, `RepoPanel`, `Attachments` |
| Inspection | `ActivityPanel`, `DevTools` |
| Voice | `VoiceControls`, `useVoice`, `lib/voice.js` |

### Notable behaviour

- **Model output is never rendered as HTML.** No `dangerouslySetInnerHTML`
  anywhere; fenced blocks are parsed into React children.
- **`” ```diff ”` blocks** render with per-line +/− colouring and two copy
  buttons — the diff, or just the resulting code. Nothing is written to disk.
- **Per-message cost** (`MessageCost`) shows model, prompt tokens, output
  tokens and wall time. On CPU the expensive part is invisible otherwise.
- **Context rail** shows what the assistant can currently see, with token
  estimates against the window, and warns when over budget.
- **Streaming speech** starts on the first complete sentence rather than
  waiting for the whole answer — a ~35 s difference. Barge-in cancels playback.
- **Both side rails default to collapsed.** Three permanent panels left the
  conversation 48% of the window; they now earn their space on request.
- **Stop** aborts the fetch, which closes the socket, which the backend detects
  and forwards to Ollama. Without that the CPU keeps generating unseen output.

---

## 10. Configuration

37 settings in `.env`; 45 environment variables read by code. All paths resolve
against the **project root**.

| Setting | Default | Notes |
|---|---|---|
| `OLLAMA_MODEL` | `qwen2.5-coder:7b` | default chat model |
| `OLLAMA_NUM_CTX` | `8192` | raised for code; see §6 |
| `OLLAMA_NUM_PREDICT` | `2048` | 512 truncated real functions |
| `OLLAMA_EMBED_MODEL` | `nomic-embed-text` | 768 dimensions |
| `OLLAMA_VISION_MODEL` | `qwen2.5vl:7b` | `VISION_KEEP_ALIVE=0` |
| `SQLITE_FILE` | `storage/ashu.db` | everything except the workbooks |
| `KNOWLEDGE_XLSX` | `storage/knowledge.xlsx` | hand-edited |
| `LOG_XLSX` | `logs/AssistantLogs.xlsx` | export target |
| `CACHE_SIMILARITY` | `0.95` | strict: a false hit is worse than a miss |
| `CACHE_MAX_ENTRIES` | `500` | LRU eviction |
| `REPO_MAX_FILES` | `400` | ~20 min at 20 files/min |
| `KNOWLEDGE_CODE_CHUNK_CHARS` | `1400` | upper bound, not fixed size |

`.env` is gitignored and holds real values; `.env.example` carries placeholders
only.

> Three credentials (Telegram, Tavily, Chroma) were committed to
> `.env.example` earlier in this project's history. Scrubbing the file does not
> remove them from git history — **they still need rotating at source.**

---

## 11. Testing

156 tests, no test framework — plain Node scripts asserting and counting, so
they run with no install step.

| Suite | Covers |
|---|---|
| `sqlite-stores` (36) | 200 concurrent writes, cascade deletes, FTS/chunk consistency, blob round-trip, WAL and FK pragmas |
| `validation` (26) | prompt type rejection, file-type detection |
| `chunker` (24) | formatting preserved, brace balance, line ranges, oversized units, CRLF, code-vs-prose detection |
| `policy` (16) | escalation thresholds, temporal override |
| `vectorStore` (16) | chunking, cosine, lexical scoring, tokenising |
| `history` (12) | sanitising untrusted client history |
| `web-stub` (9) | web path with a stubbed provider |
| `markdown` (7) | fenced-block splitting, unterminated fences |
| `stream` / `barge-in` (10) | sentence-boundary speech, cancellation |

**Any test touching a store must set `SQLITE_FILE`.** Two legacy tests set the
old `DB_FILE`/`CACHE_FILE` variables instead, connected to the real database,
and wrote 50 rows into it before failing. They were removed.

---

## 12. Known limits

**CPU-only inference is the hard floor.** ~15.8 tok/s prompt eval and ~3.5
tok/s generation on a 7B. No configuration change fixes this; it is the machine.

**`OLLAMA_MAX_LOADED_MODELS` is unset.** Two 7B models resident consume
10.7 GB of 16.9 GB and cause swapping — one observed vision run took 407 s.
Setting it to `1` prevents that. It is a system environment variable, not a
project setting.

**Retrieval is not perfect.** Top-1 file retrieval is 4/5 on this codebase. The
remaining miss returns genuinely related files rather than nonsense. Fixing it
properly needs an LLM-generated summary per chunk, which at 5 tok/s is not
worth the cost.

**Voice cannot be tested headlessly.** Microphone input requires a real browser
session; Phases 1–3 are verified by unit tests and code path only. Only English
TTS voices are installed, so the other nine languages fall back until voice
packs are added in Windows settings.

**Conversation history is single-threaded.** One conversation at a time,
persisted to `localStorage` (60 messages). There is no multi-conversation
sidebar.

**`storage/uploads/` is unused.** Uploaded files are extracted to text at
upload time and the original is discarded; the text lives in `files.text`.

---

## 13. Running it

```bash
# Ollama, once
ollama pull qwen2.5-coder:7b
ollama pull nomic-embed-text

# Backend
cd backend && npm install && npm start        # :5000

# Frontend
cd frontend && npm install && npm run dev     # :5173
```

First run on an existing installation: import the legacy JSON stores.

```bash
node backend/src/storage/migrate.js --check
```

`better-sqlite3` is a native module and needs a build toolchain if no prebuilt
binary matches the platform.
