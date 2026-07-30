// Decides where an answer should come from. Kept free of I/O so the escalation
// rules can be unit-tested directly.

// Embedding cosine scores and lexical hit-ratios are not comparable, so each
// scoring mode gets its own threshold.
const THRESHOLDS = {
  embedding: Number(process.env.RELEVANCE_THRESHOLD_EMBEDDING || 0.62),
  lexical: Number(process.env.RELEVANCE_THRESHOLD_LEXICAL || 0.5)
};

// Questions about the present can't be answered from a static knowledge base
// or from model weights, so these escalate regardless of internal scores.
const TEMPORAL_PATTERNS = [
  /\b(latest|newest|current|currently|today|tonight|tomorrow|yesterday)\b/i,
  /\b(this|next|last)\s+(week|month|year|quarter)\b/i,
  /\b(recent|recently|up[- ]?to[- ]?date|breaking|news)\b/i,
  /\b(price|stock|weather|score|release[ds]?|version)\b/i,
  /\b20(2[4-9]|[3-9]\d)\b/
];

// Phrases a local model uses when it has nothing useful to say.
const UNKNOWN_PATTERNS = [
  /\bi (do not|don't) (know|have)\b/i,
  /\bi('m| am) not (sure|certain|aware)\b/i,
  /\bno (relevant )?(information|context|data) (was )?(found|available|provided)\b/i,
  /\bcannot (answer|determine|find)\b/i,
  /\bunable to (answer|determine|find)\b/i,
  /\b(as of my|my) (knowledge|training) (cut[- ]?off|data)\b/i,
  /\bi (don't|do not) have access\b/i
];

function isTemporalQuery(prompt) {
  return TEMPORAL_PATTERNS.some((re) => re.test(prompt));
}

function looksUnknown(answer) {
  const text = String(answer || '');
  if (!text.trim()) return true;
  return UNKNOWN_PATTERNS.some((re) => re.test(text));
}

function thresholdFor(mode) {
  return THRESHOLDS[mode] ?? THRESHOLDS.lexical;
}

/**
 * Decides whether internal context is good enough to answer from.
 * Returns { sufficient, topScore, threshold, reason }.
 */
function evaluateInternal({ matches, mode }, prompt) {
  const topScore = matches.length ? matches[0].score : 0;
  const threshold = thresholdFor(mode);

  if (isTemporalQuery(prompt)) {
    return { sufficient: false, topScore, threshold, reason: 'query asks for current information' };
  }
  if (!matches.length) {
    return { sufficient: false, topScore, threshold, reason: 'knowledge base is empty' };
  }
  if (topScore < threshold) {
    return {
      sufficient: false,
      topScore,
      threshold,
      reason: `best internal match ${topScore.toFixed(2)} is below ${threshold} (${mode})`
    };
  }

  return { sufficient: true, topScore, threshold, reason: `internal match ${topScore.toFixed(2)} (${mode})` };
}

module.exports = {
  evaluateInternal,
  isTemporalQuery,
  looksUnknown,
  thresholdFor,
  THRESHOLDS
};
