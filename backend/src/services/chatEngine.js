const { generateCompletion } = require('../config/ollama');
const repository1 = require('../repositories/repository1');
const vectorStore = require('../knowledge/vectorStore');
const fileStore = require('../files/store');
const { searchWeb, isWebSearchEnabled } = require('../search/webSearch');
const { evaluateInternal, looksUnknown, isTemporalQuery } = require('./retrievalPolicy');
const excelStore = require('../knowledge/excelStore');
const semanticCache = require('../knowledge/semanticCache');

// Confidence per source, used for the badge shown next to every answer.
// Curated Excel rows outrank everything: a human wrote them for this exact
// question. Model knowledge is lowest because nothing verifies it.
const CONFIDENCE = {
  file: 0.97,
  excel: 1,
  cache: 0.93,
  internal: 0.9,
  web: 0.78,
  model: 0.6
};

// The old prompt capped answers at 70 words, which made the model give shallow
// replies and stop mid-explanation. Guide the shape of a good answer instead of
// imposing a hard length limit.
const BASE_SYSTEM_PROMPT = [
  'You are Ashu Codex AI, a precise engineering assistant.',
  'Answer the question directly — never open with a greeting or introduce yourself.',
  'Be concise but complete: give the full answer, then stop. Do not pad or repeat.',
  'Use markdown. Put code in fenced blocks with a language tag.',
  'Prefer concrete specifics — names, commands, numbers — over general advice.',
  'If you are unsure or lack the information, say so plainly rather than guessing.',
  // The UI renders ```diff blocks with per-line colouring, so a change to code
  // the user already has reads as a change rather than as a wall of new code
  // they have to diff by eye.
  'When you change code that already exists, show it as a unified diff in a ```diff block',
  '(- for removed lines, + for added), and give the file and line range above it.',
  'Write a full ```<language> block only for genuinely new code.'
].join(' ');

// The model's training data is older than the sources we retrieve, so it must
// be told explicitly to distrust its own memory — otherwise it answers from
// training weights and silently ignores fresher retrieved facts.
const GROUNDED_RULES =
  'The Reference Material below is current and authoritative. ' +
  'Base your answer on it, not on your training data, which is out of date. ' +
  'If the Reference Material contradicts what you remember, the Reference Material is correct. ' +
  'Never say "as of my last update" — state what the Reference Material says. ' +
  'If it genuinely does not contain the answer, say so plainly instead of guessing.';

// Context size is owned by config/ollama.js and shared by every request, so
// the model never reloads. Only the output length varies here: a grounded
// answer summarising sources needs more room than a one-line chat reply.
const GROUNDED_NUM_PREDICT = Number(process.env.GROUNDED_NUM_PREDICT || 640);

// History is dropped for grounded answers when it would crowd out the sources;
// the retrieved material matters more than older small talk.
const GROUNDED_HISTORY_TURNS = Number(process.env.GROUNDED_HISTORY_TURNS || 3);

function isGreeting(prompt) {
  return /^(hi|hello|hey|hii|hola|namaste|good morning|good afternoon|good evening)[!. ]*$/i.test(prompt.trim());
}

function cleanResponse(responseText) {
  return responseText
    .replace(/^hello!?\s*i'?m\s+ashu,?\s+a\s+codex\s+ai\.?\s*/i, 'Hi. ')
    .replace(/^as\s+ashu\s+codex\s+ai,?\s*/i, '')
    .replace(/^here'?s\s+a\s+brief\s+introduction:?\s*/i, '')
    .trim();
}

function normalize(prompt) {
  const normalizedPrompt = String(prompt || '').trim();
  if (!normalizedPrompt) {
    const error = new Error('Prompt is required');
    error.statusCode = 400;
    throw error;
  }
  return normalizedPrompt;
}

/**
 * `box` is a per-request object that collects telemetry from the model call.
 *
 * This used to be a module-level `lastTelemetry`, which leaked between
 * concurrent requests: with two in flight, the one that finished second
 * overwrote the first's token counts before it was read. Reproduced with a
 * slow log write — the fast request reported the slow request's tokens.
 */
async function ask(prompt, history, referenceMaterial, onToken, signal, box, model) {
  if (!referenceMaterial) {
    const raw = await generateCompletion(model, prompt, BASE_SYSTEM_PROMPT, history, { onToken, signal });
    if (box) box.telemetry = raw.telemetry || null;
    return cleanResponse(raw.response || '');
  }

  const today = new Date().toISOString().slice(0, 10);
  const systemPrompt =
    `${BASE_SYSTEM_PROMPT}\n\nToday's date is ${today}.\n\n${GROUNDED_RULES}\n\n` +
    `Reference Material:\n${referenceMaterial}`;

  const trimmedHistory = history.slice(-GROUNDED_HISTORY_TURNS * 2);

  const raw = await generateCompletion(model, prompt, systemPrompt, trimmedHistory, {
    num_predict: GROUNDED_NUM_PREDICT,
    onToken,
    signal
  });
  if (box) box.telemetry = raw.telemetry || null;
  return cleanResponse(raw.response || '');
}

// Code chunks carry the line range they came from, so the model is told where
// each excerpt sits in the file. Without it, an answer about a 2,000-line file
// can only say "in your code" instead of "at db.js:14".
function locationOf(match) {
  if (!match.startLine) return match.title;
  return `${match.title}:${match.startLine}-${match.endLine}`;
}

function formatInternal(matches) {
  return matches
    .map((m, i) => `[${i + 1}] ${locationOf(m)}\n${m.text}`)
    .join('\n\n');
}

// A single PDF can run tens of thousands of characters — far past the context
// window — so long documents are excerpted down to the passages that actually
// relate to the question instead of being truncated at the top.
const FILE_CONTEXT_CHARS = Number(process.env.FILE_CONTEXT_CHARS || 4000);
const WINDOW_CHARS = 700;

function selectRelevantExcerpt(text, query, budget) {
  if (text.length <= budget) return text;

  const terms = vectorStore.tokenize(query);
  const windows = [];
  for (let i = 0; i < text.length; i += WINDOW_CHARS) {
    windows.push({ at: i, body: text.slice(i, i + WINDOW_CHARS) });
  }

  const scored = windows
    .map((w) => ({ ...w, score: vectorStore.lexicalScore(terms, w.body) }))
    .sort((a, b) => b.score - a.score || a.at - b.at);

  // No term matched anywhere: fall back to the opening, which usually carries
  // the title, headings and summary.
  if (!scored.length || scored[0].score === 0) {
    return `${text.slice(0, budget)}\n[…document truncated…]`;
  }

  const picked = [];
  let used = 0;
  for (const w of scored) {
    if (used + w.body.length > budget) continue;
    picked.push(w);
    used += w.body.length;
    if (used >= budget) break;
  }

  // Restore document order so the excerpt still reads coherently.
  picked.sort((a, b) => a.at - b.at);
  return picked.map((w) => w.body).join('\n[…]\n');
}

function formatFiles(files, query) {
  const budget = Math.floor(FILE_CONTEXT_CHARS / files.length);
  return files
    .map((f) => {
      const body = selectRelevantExcerpt(f.text, query, budget);
      return `[file: ${f.filename}${f.meta?.pages ? `, ${f.meta.pages} pages` : ''}]\n${body}`;
    })
    .join('\n\n');
}

function formatWeb(results, tavilyAnswer) {
  const sections = results.map((r, i) => `[${i + 1}] ${r.title} (${r.url})\n${r.content}`);
  if (tavilyAnswer) sections.unshift(`Summary from search provider:\n${tavilyAnswer}`);
  return sections.join('\n\n');
}

/**
 * Retrieval pipeline, in escalation order:
 *   1. internal knowledge base — answer from it when the match is strong
 *   2. the model's own knowledge — for questions it can reasonably know
 *   3. web search — when the model doesn't know, or the question needs
 *      current information the model cannot have
 *
 * Step 2 is skipped for time-sensitive questions, where the model's training
 * data is guaranteed stale, and it is what keeps general questions from
 * burning a web search on every turn.
 *
 * Always resolves to { answer, origin, sources, trace }.
 */
async function processPrompt(prompt, history = [], fileIds = [], events = {}) {
  const normalizedPrompt = normalize(prompt);
  const trace = [];

  // A per-request model, already validated against what Ollama actually has.
  // Undefined means "use the configured default", which is the common path.
  const model = events.model || undefined;

  // Streaming hooks. A streamed attempt can still be rejected (the model may
  // admit it does not know), so onReset tells the client to discard what it has
  // shown before the next attempt streams in.
  const emitToken = typeof events.onToken === 'function' ? events.onToken : null;
  const rawStage = typeof events.onStage === 'function' ? events.onStage : () => {};
  const emitReset = typeof events.onReset === 'function' ? events.onReset : () => {};
  const signal = events.signal;

  // Structured, timed execution steps. These drive the live activity panel and
  // the replayable timeline — the whole point of an inspectable assistant is
  // that every stage reports what it did and how long it took.
  const t0 = Date.now();
  const box = { telemetry: null };
  const timeline = [];
  let openStep = null;

  const step = (key, label) => {
    if (openStep) closeStep('done');
    openStep = { key, label, startedAt: Date.now(), at: Date.now() - t0 };
    rawStage({ key, label, status: 'running', at: openStep.at });
    return openStep;
  };

  const closeStep = (status, detail) => {
    if (!openStep) return;
    const entry = {
      key: openStep.key,
      label: openStep.label,
      status,
      detail: detail || undefined,
      at: openStep.at,
      ms: Date.now() - openStep.startedAt
    };
    timeline.push(entry);
    rawStage(entry);
    openStep = null;
  };

  // A step that starts and finishes together (a lookup that either hit or not).
  const mark = (key, label, status, detail) => {
    const at = Date.now() - t0;
    const entry = { key, label, status, detail: detail || undefined, at, ms: 0 };
    timeline.push(entry);
    rawStage(entry);
  };

  const finish = (result) => ({
    ...result,
    timeline,
    totalMs: Date.now() - t0,
    // null for Excel/cache hits — nothing was sent to a model, which is the
    // point: DevTools should show zero tokens for those.
    telemetry: box.telemetry
  });

  mark('received', 'Question received', 'done');

  // Greetings short-circuit before anything else. Placing this after the Excel
  // and cache lookups cost 115ms per "hi" — 101ms of it an embedding round-trip
  // for a question no source could ever answer better than a fixed reply.
  if (!(Array.isArray(fileIds) && fileIds.length) && isGreeting(normalizedPrompt)) {
    const answer = 'Hi! How can I help?';
    if (emitToken) emitToken(answer);
    mark('greeting', 'Greeting shortcut', 'hit');
    await repository1.saveLog({ prompt: normalizedPrompt, response: answer });
    return finish({ answer, origin: 'greeting', confidence: 1, sources: [], trace: ['greeting shortcut'] });
  }

  // --- 0. attached files ------------------------------------------------------
  // An explicitly attached document outranks everything else: the user is
  // asking about *this* file, so no retrieval or web search should override it.
  if (Array.isArray(fileIds) && fileIds.length) {
    const files = await fileStore.getFiles(fileIds);

    if (files.length) {
      const usable = files.filter((f) => f.text && f.text.trim());

      if (!usable.length) {
        const reasons = files.map((f) => f.warning || 'no readable text').join('; ');
        closeStep('miss');
        return finish({
          answer: `I could not read any text from the attached file(s): ${reasons}`,
          origin: 'file',
          confidence: 0,
          sources: files.map((f) => ({ type: 'file', title: f.filename, reference: f.kind })),
          trace: [...trace, 'attached files contained no extractable text']        });
      }

      trace.push(`answering from ${usable.length} attached file(s)`);
      step('file', `Reading ${usable.length} attached file(s)`);
      const answer = await ask(normalizedPrompt, history, formatFiles(usable, normalizedPrompt), emitToken, signal, box, model);

      await repository1.saveLog({ prompt: normalizedPrompt, response: answer });
      closeStep('done');
      return finish({
        answer,
        origin: 'file',
        confidence: CONFIDENCE.file,
        sources: usable.map((f) => ({
          type: 'file',
          title: f.filename,
          reference: `${f.kind}${f.meta?.pages ? `, ${f.meta.pages} pages` : ''}`
        })),
        trace      });
    }

    trace.push('attached file ids not found, falling back to normal retrieval');
  }

  // --- 1. Excel workbook -----------------------------------------------------
  // Curated rows are the fastest and most trustworthy source: a hit answers in
  // ~1ms with no LLM call at all, versus ~35s for a generated reply.
  try {
    step('excel', 'Searching Excel workbook');
    const excel = await excelStore.search(normalizedPrompt);
    if (excel.hit) {
      const answer = excelStore.formatAnswer(excel);
      closeStep('hit', `${excel.sheet} row ${excel.rowNumber}`);
      trace.push(`excel: matched ${excel.sheet} row ${excel.rowNumber}`);
      if (emitToken) emitToken(answer);
      await repository1.saveLog({ prompt: normalizedPrompt, response: answer });
      closeStep('done');
    return finish({
        answer,
        origin: 'excel',
        confidence: excel.confidence,
        sources: [{ type: 'excel', title: `${excel.sheet} sheet`, reference: `row ${excel.rowNumber}` }],
        trace      });
    }
    closeStep('miss', `best ${excel.confidence}`);
    trace.push(`excel: no match (best ${excel.confidence})`);
  } catch (error) {
    trace.push(`excel lookup failed: ${error.message}`);
  }

  // --- 2. semantic cache -----------------------------------------------------
  // A close paraphrase of an earlier question is answered instantly.
  try {
    step('cache', 'Checking semantic cache');
    const cached = await semanticCache.lookup(normalizedPrompt);
    if (cached.hit) {
      closeStep('hit', `${(cached.similarity*100).toFixed(0)}% similar`);
      trace.push(`cache: ${(cached.similarity * 100).toFixed(0)}% match with "${cached.question}"`);
      if (emitToken) emitToken(cached.answer);
      closeStep('done');
      return finish({
        answer: cached.answer,
        origin: 'cache',
        confidence: cached.similarity,
        sources: cached.sources || [],
        trace      });
    }
    closeStep('miss', `best ${cached.similarity}`);
    trace.push(`cache: miss (best ${cached.similarity})`);
  } catch (error) {
    trace.push(`cache lookup failed: ${error.message}`);
  }


  // --- 1. internal knowledge -------------------------------------------------
  let internal = { matches: [], mode: 'empty' };
  try {
    step('knowledge', 'Searching knowledge base');
    internal = await vectorStore.search(normalizedPrompt);
  } catch (error) {
    trace.push(`internal search failed: ${error.message}`);
  }

  const verdict = evaluateInternal(internal, normalizedPrompt);
  closeStep(verdict.sufficient ? 'hit' : 'miss', verdict.reason);
  trace.push(`internal: ${verdict.reason}`);

  if (verdict.sufficient) {
    step('generate', 'Generating from knowledge base');
    // Widen the best match with its neighbours before building the prompt —
    // the answer is often split across a chunk boundary.
    const widened = vectorStore.expandContext(internal.matches, {
      budgetChars: Number(process.env.INTERNAL_CONTEXT_CHARS || 3000)
    });

    const answer = await ask(normalizedPrompt, history, formatInternal(widened), emitToken, signal, box, model);

    // The model may still reject the context as unhelpful; treat that as a miss.
    if (!looksUnknown(answer)) {
      await repository1.saveLog({ prompt: normalizedPrompt, response: answer });
      closeStep('done');
      return finish({
        answer,
        origin: 'internal',
        confidence: Number(Math.min(1, verdict.topScore).toFixed(3)),
        sources: internal.matches.map((m) => ({
          type: 'internal',
          title: locationOf(m),
          reference: m.source,
          startLine: m.startLine ?? null,
          endLine: m.endLine ?? null,
          score: Number(m.score.toFixed(3))
        })),
        trace      });
    }
    trace.push('model could not answer from internal context, escalating');
    emitReset();
  }

  // --- 2. the model's own knowledge -----------------------------------------
  // Skipped for time-sensitive questions: the model cannot know current facts,
  // so asking first would only waste a slow inference pass before escalating.
  let modelAnswer = '';
  const temporal = isTemporalQuery(normalizedPrompt);

  if (!temporal) {
    step('model', 'Asking the model');
    modelAnswer = await ask(normalizedPrompt, history, '', emitToken, signal, box, model);

    if (!looksUnknown(modelAnswer)) {
      trace.push('model answered from its own knowledge');
      await repository1.saveLog({ prompt: normalizedPrompt, response: modelAnswer });
      await semanticCache.remember({ question: normalizedPrompt, answer: modelAnswer, origin: 'model', sources: [] });
      closeStep('done');
      return finish({ answer: modelAnswer, origin: 'model', confidence: CONFIDENCE.model, sources: [], trace });
    }
    trace.push('model does not know, escalating to web');
    emitReset();
  } else {
    trace.push('time-sensitive question, going straight to web');
  }

  // --- 3. web escalation -----------------------------------------------------
  if (isWebSearchEnabled()) {
    step('web', 'Searching the web');
    const web = await searchWeb(normalizedPrompt);

    if (web.ok && web.results.length) {
      trace.push(`web: ${web.results.length} results`);
      closeStep('done');
      step('generate', 'Reading search results');
      const answer = await ask(normalizedPrompt, history, formatWeb(web.results, web.answer), emitToken, signal, box, model);

      await repository1.saveLog({ prompt: normalizedPrompt, response: answer });
      closeStep('done');
      return finish({
        answer,
        origin: 'web',
        confidence: CONFIDENCE.web,
        sources: web.results.map((r) => ({
          type: 'web',
          title: r.title,
          url: r.url,
          score: r.score
        })),
        trace      });
    }

    trace.push(`web unavailable: ${web.reason || 'no results'}`);
  } else {
    trace.push('web search disabled (TAVILY_API_KEY not set)');
  }

  // --- 4. last resort --------------------------------------------------------
  // Reuse the step-2 answer rather than paying for another inference pass.
  // If step 2 already streamed this answer, emitReset() has since cleared it on
  // the client, so it has to be re-sent rather than silently vanishing.
  const answer = modelAnswer || (await ask(normalizedPrompt, history, '', emitToken, signal, box, model));
  if (modelAnswer && emitToken) emitToken(modelAnswer);
  await repository1.saveLog({ prompt: normalizedPrompt, response: answer });

  closeStep('done');
  return finish({ answer, origin: 'model', confidence: CONFIDENCE.model, sources: [], trace });
}

module.exports = {
  processPrompt
};
