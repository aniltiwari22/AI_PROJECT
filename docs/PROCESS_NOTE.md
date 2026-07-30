# Ashu Codex AI — Process Note

**Version 2.1** · operational procedures · owner: Anil Tiwari

This note covers **how the system is run**: what happens on each request, the
day-to-day procedures, what to check when something looks wrong, and how the
data is looked after. For architecture, schema and API detail see
[TECHNICAL.md](TECHNICAL.md).

---

## 1. Purpose and scope

| | |
|---|---|
| **What it is** | A private engineering assistant running entirely on one machine |
| **Who uses it** | Single user, local browser at `http://localhost:5173` |
| **What leaves the machine** | Nothing, except an optional Tavily web search |
| **Where data lives** | `storage/ashu.db` and `storage/knowledge.xlsx`, in the project folder |
| **Dependencies** | Ollama running on `:11434`; no cloud service, no external database |

**In scope:** answering questions from curated knowledge, an indexed codebase,
uploaded documents, the model's own knowledge, or the web; reading code; voice
conversation; request logging and benchmarking.

**Out of scope:** multi-user access, authentication beyond a stub route,
writing to your files (the assistant proposes diffs; applying them is manual),
and anything requiring a GPU.

---

## 2. What happens when you ask a question

Every request walks the same escalation, stopping at the first source that
answers well enough. The Activity panel shows this live; the trace is stored
with each answer.

```
Question
   │
   ├─ 1. Greeting?  ──────────────► answer instantly (~10 ms)
   │
   ├─ 2. File attached? ─────────► answer from the document        (conf 0.97)
   │
   ├─ 3. Match in knowledge.xlsx? ► answer from the curated row    (conf 1.00)
   │
   ├─ 4. Similar question cached? ► reuse the stored answer        (conf 0.93)
   │        (cosine ≥ 0.95)                        ~0.13 s
   │
   ├─ 5. Match in indexed code?  ─► answer with file:line citation (conf 0.90)
   │
   ├─ 6. Ask the model ──────────► answer from its own knowledge   (conf 0.60)
   │        skipped for "latest / current / 2026" style questions
   │        if it says "I don't know", escalate ↓
   │
   └─ 7. Web search ─────────────► answer from sources             (conf 0.78)
```

**Why the order matters.** A curated Excel row outranks everything because a
human wrote it for that exact question. The model ranks lowest because nothing
verifies it. Steps 1–4 involve no model call at all — **52% of logged requests
are answered this way**, at a median of 0.13 s against 24 s for a generation.

Every answer carries its origin and confidence in the UI, so you always know
whether you are reading curated fact or model guesswork.

---

## 3. Daily operation

### Starting up

| Order | Action | Check |
|---|---|---|
| 1 | Ollama running | `curl http://localhost:11434/api/tags` |
| 2 | Backend | `cd backend && npm start` → `:5000` |
| 3 | Frontend | `cd frontend && npm run dev` → `:5173` |
| 4 | Confirm | Top bar shows **LOCAL** and green tool chips |

The backend warms the model on boot, so the first question after start is not
slower than the rest.

### Reading the top bar

Six chips, each driven by `/health` — a chip is green only if that subsystem
reported itself working. They are not decorative.

| Chip | Green means |
|---|---|
| Ollama | model loaded and responding |
| Excel | `knowledge.xlsx` has data rows |
| Knowledge | at least one document indexed |
| Web | Tavily API key present |
| Vision | image-reading model available |
| Cache | cached answers exist |

CPU and RAM are live readings. **There is no GPU gauge** — this machine has no
discrete GPU and Ollama runs on the CPU.

### Shutting down

Stop the frontend, then the backend, with Ctrl-C. SQLite is in WAL mode, so an
abrupt stop does not corrupt data — but a clean stop checkpoints the WAL and
keeps the next start faster.

---

## 4. Adding knowledge

Four ways in, in order of how much they cost you.

### 4.1 Curated answers — `knowledge.xlsx` (best)

Open `storage/knowledge.xlsx` in Excel and add a row to the appropriate sheet:
**FAQs, APIs, Errors, SQL, Jira, Emails**.

- Answers from here are instant and carry confidence 1.00.
- Matching is identifier-first, so an error code or ticket ID in the question
  finds its row directly.
- The file is re-read when its modification time changes — no restart needed.

**Use this for anything you have answered more than twice.** It is the cheapest
possible answer and the only one you control completely.

### 4.2 Index a codebase

Context rail → **Codebase** → enter a folder path → **Check** → **Index**.

- Check first. It reports file count and estimated chunks so you see the cost
  before spending it.
- Budget roughly **1 minute per 20 files**. 34 files took 110 s.
- Read-only: the assistant walks and reads the folder and never writes to it.
- Re-indexing replaces the previous snapshot; it does not duplicate.
- `node_modules`, `.git`, `dist`, build output, binaries and minified files are
  skipped automatically.

Answers then cite `semanticCache.js:70-105` rather than pointing vaguely at
"your code".

### 4.3 Attach a document to one question

Paperclip in the composer, or **Add files** in the Context rail. Accepts PDF,
DOCX, PPTX, images, plain text and 39 source-code extensions.

The rail shows a token estimate per file and warns when the total exceeds the
context window. **Watch this number** — see §7.

### 4.4 Let the cache fill itself

Nothing to do. Any answer that is not from the web is remembered with its
embedding; a close paraphrase later is served from the cache in ~0.13 s. Web
answers are deliberately never cached, because they go stale.

---

## 5. Periodic tasks

| Frequency | Task | How |
|---|---|---|
| Weekly | Export the log workbooks | §5.1 |
| Weekly | Back up the database | §5.2 |
| Monthly | Review the Benchmark view for slow origins | Nav → Benchmark |
| Monthly | Promote repeated questions into `knowledge.xlsx` | §5.3 |
| After a code change | Re-index the affected folder | Context rail |
| Ad hoc | Clear the cache if answers feel stale | §5.4 |

### 5.1 Export the log workbooks

Logs are recorded in SQLite and the `.xlsx` files are produced on demand — the
app no longer holds a workbook open for writing.

```bash
curl -X POST http://localhost:5000/api/v1/analytics/export -H "Content-Type: application/json" -d "{\"which\":\"all\"}"
```

Writes `logs/AssistantLogs.xlsx` (one sheet per month) and `logs/VoiceLogs.xlsx`.

### 5.2 Back up the data

Three things matter: `storage/ashu.db`, `storage/knowledge.xlsx`, `.env`.
Together about **1.2 MB**.

**Do not copy `ashu.db` on its own while the backend is running.** Recent writes
live in the write-ahead log — currently 4 MB of it — so a plain copy gives a
stale snapshot.

Either stop the backend first and copy all three files, or take a consistent
live snapshot:

```bash
cd backend && node -e "const D=require('better-sqlite3');const d=new D('../storage/ashu.db',{readonly:true});d.exec(\"VACUUM INTO '../storage/backup.db'\");d.close();console.log('done')"
```

`VACUUM INTO` is safe against a live database and produces a single compact file
— verified at 512 KB with `PRAGMA integrity_check` returning `ok`.

### 5.3 Promote repeated questions

Nav → **Benchmark** lists the most-asked questions. Anything appearing several
times, and answered by `model` rather than `excel` or `cache`, is a candidate
for a curated row. Moving it takes that question from ~24 s to instant.

### 5.4 Clear the semantic cache

The cache holds 500 entries with 7-day expiry and evicts least-recently-used.
It only needs clearing if underlying facts changed and you are being served a
now-wrong answer with high confidence.

---

## 6. Monitoring

| Where | Shows |
|---|---|
| Top bar | Live subsystem chips, CPU, RAM |
| Nav → **Health** | Full `/health` payload per subsystem |
| Nav → **Benchmark** | Request counts, median times, origin split |
| Per message | Model, prompt tokens, output tokens, wall time |
| DevTools per message | Exact system prompt, retrieval trace, step timings |

A degraded subsystem shows as that subsystem's error, not as a general failure —
one failing store does not hide the health of the rest.

---

## 7. What "slow" means here, and what to do

The machine has no GPU. Inference runs on 8 CPU cores at roughly **15.8 tokens
per second reading** and **3.5 tokens per second writing** on a 7B model. These
are floors, not bugs.

| Observation | Expected? | Action |
|---|---|---|
| Cached / Excel answer, under 1 s | yes | none |
| Fresh model answer, 20–40 s | yes | none |
| Question about an attached file, 90 s+ | yes | attach fewer or smaller files |
| First question after switching model, 100–400 s | yes | see below |
| Web-search answer, 90–100 s | yes | none |
| Every answer slow, including greetings | **no** | §8 |

### Attachment size is the main lever you control

Reading two small source files (10 KB) costs the 7B model **164 seconds before
it writes a single token**. The Context rail's token estimate is the number to
watch. Prefer indexing a codebase — retrieval then sends 2–3 relevant functions
instead of whole files.

### Do not switch models casually

Measured on the same question: a model **cold after a switch took 378 s**; the
same model **warm took 7 s**. Pick one model and stay on it for a session. The
picker is deliberately a sticky manual choice, not automatic routing.

Warm, the small `deepseek-coder` is ~3.3× faster than `qwen2.5-coder:7b` — but
in that test its answer was wrong where qwen's was right. Speed is a trade-off.

---

## 8. Troubleshooting

| Symptom | Likely cause | Fix |
|---|---|---|
| Top bar shows **Offline** | Backend not running | `cd backend && npm start` |
| Ollama chip grey | Ollama daemon stopped | Start Ollama, then re-check `/health` |
| Everything slow, machine swapping | Two 7B models resident (10.7 GB of 16.9 GB) | Set `OLLAMA_MAX_LOADED_MODELS=1`; see §10 |
| Answers ignore an attached file | File too large for the window | Check the rail's token estimate; attach less |
| "Knowledge" chip grey after indexing | Index was removed, or indexing failed | Re-index from the Context rail |
| Keyword-quality answers, not semantic | Embedding model unavailable | `ollama pull nomic-embed-text` |
| Voice does not start | Not Chrome or Edge; mic denied | Use Chrome/Edge, allow microphone |
| Reply spoken in the wrong accent | Only English voices installed | Add language voice packs in Windows settings |
| Upload rejected as "unsupported" | Extension not on the accept list | Rename to a supported extension, or paste the content |
| Excel chip grey | Workbook has headers but no data rows | Add rows to `knowledge.xlsx` |

### Escalation

There is no second line — this is a single-machine, single-user system. When
stuck: check `/health` first, then the backend console output, then the request
trace in DevTools for the specific answer that went wrong. The trace records
which sources were consulted and what each returned.

---

## 9. Data handling

| Data | Where | Contains |
|---|---|---|
| Conversations | `chat_logs` | every prompt and response, in plain text |
| Uploaded documents | `files` | extracted text of everything uploaded |
| Cached answers | `cache` | questions, answers, embeddings |
| Indexed code | `documents`, `chunks` | source code from indexed folders |
| Request log | `request_logs` | question, origin, confidence, timing, model |
| Voice turns | `voice_logs` | transcripts |

**Nothing is encrypted.** `storage/ashu.db` is a plain SQLite file readable by
anyone with access to the machine or a backup of it.

**Nothing is sent anywhere** except web-search queries when Tavily is enabled
and the pipeline reaches step 7. Voice recognition and speech both run in the
browser; no audio leaves the page.

**Retention is indefinite** — there is no automatic purge of conversations or
logs. The semantic cache is the only store that expires (7 days, 500 entries).

### Repository hygiene

`.gitignore` excludes `storage/`, `logs/`, `.env` and all backups. Real
credentials belong in `.env` only; `.env.example` carries placeholders.

> **Outstanding action.** The Telegram bot token, Tavily key and Chroma key were
> committed to `.env.example` earlier in this project's history. Scrubbing the
> file does not remove them from git history — **rotate all three at source**
> (BotFather, tavily.com, Chroma).

---

## 10. Machine configuration

One setting is not in `.env` because it belongs to Ollama, not this project:

```
OLLAMA_MAX_LOADED_MODELS=1
```

Without it, two 7B models can sit resident at once, consuming 10.7 GB of
16.9 GB and pushing the machine into swap — one observed image-reading run took
407 s as a result. Set it as a Windows environment variable and restart Ollama.

---

## 11. Change procedure

| Step | Action |
|---|---|
| 1 | Make the change |
| 2 | `node --check` every touched backend file, or start the server |
| 3 | Run the test suites (156 tests) |
| 4 | `cd frontend && npm run build` |
| 5 | Exercise the affected path against the running server |
| 6 | Commit |

**Any test that touches a store must set `SQLITE_FILE` to a throwaway path.**
Two tests once set the older `DB_FILE`/`CACHE_FILE` variables instead,
connected to the real database, and wrote 50 rows into it before failing.

Before a schema change, add the column in `sqlite.js::migrate` as well as in
`SCHEMA` — `CREATE TABLE IF NOT EXISTS` does nothing to a table that already
exists, so an existing database would be missing the column and every insert
would fail.

---

## 12. Current state

| | |
|---|---|
| Version | 2.1 |
| Tests | 156 passing |
| Database | `storage/ashu.db` |
| Storage engine | SQLite (WAL) for everything except `knowledge.xlsx` |
| Indexed codebases | none currently |

Row counts are deliberately not listed here — they change every time the
assistant is used, so any figure written down is wrong within minutes. Read
them live instead:

```bash
curl -s http://localhost:5000/health
```

`database.chatLogCount`, `cache.entries`, `knowledge.documents` and
`logs.totalRows` are the four that matter. Nav → **Health** shows the same
payload in the UI.

### Open items

| Item | Note |
|---|---|
| **Rotate three credentials** | Security. Committed to git history. |
| **Nothing is committed** | 130+ changed files in the working tree. |
| `OLLAMA_MAX_LOADED_MODELS` unset | Causes swapping under memory pressure. |
| Multi-source search (#29) | Parallel GitHub / StackOverflow / docs lookups. |
| Prompt Studio (#30) | Live prompt editing and A/B comparison. |
| Voice Phase 4 (#34) | Wake word, voice commands, speaker profiles. |
