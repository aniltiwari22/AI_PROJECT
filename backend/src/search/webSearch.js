// Tavily web search. Uses native fetch (Node 18+) so no new dependency is
// required. Never throws: a failed search degrades to "no results" so the
// assistant can still answer from the model alone.

const TAVILY_API_KEY = process.env.TAVILY_API_KEY || '';
const TAVILY_URL = 'https://api.tavily.com/search';
const SEARCH_TIMEOUT_MS = Number(process.env.WEB_SEARCH_TIMEOUT_MS || 20000);
const MAX_RESULTS = Number(process.env.WEB_SEARCH_MAX_RESULTS || 3);
const MAX_CONTENT_CHARS = Number(process.env.WEB_SEARCH_MAX_CONTENT_CHARS || 700);

function isWebSearchEnabled() {
  return Boolean(TAVILY_API_KEY);
}

function webSearchStatus() {
  return {
    enabled: isWebSearchEnabled(),
    provider: 'tavily',
    maxResults: MAX_RESULTS
  };
}

async function searchWeb(query) {
  if (!isWebSearchEnabled()) {
    return { ok: false, reason: 'TAVILY_API_KEY is not set', results: [], answer: '' };
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), SEARCH_TIMEOUT_MS);

  try {
    const response = await fetch(TAVILY_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      signal: controller.signal,
      body: JSON.stringify({
        api_key: TAVILY_API_KEY,
        query,
        search_depth: 'basic',
        include_answer: true,
        max_results: MAX_RESULTS
      })
    });

    if (!response.ok) {
      const detail = await response.text().catch(() => '');
      return {
        ok: false,
        reason: `Tavily responded ${response.status}${detail ? `: ${detail.slice(0, 200)}` : ''}`,
        results: [],
        answer: ''
      };
    }

    const body = await response.json();

    const results = (Array.isArray(body.results) ? body.results : []).map((item) => ({
      title: item.title || 'Untitled',
      url: item.url,
      content: String(item.content || '').slice(0, MAX_CONTENT_CHARS),
      score: typeof item.score === 'number' ? item.score : null
    }));

    return { ok: true, results, answer: String(body.answer || '') };
  } catch (error) {
    const reason = error.name === 'AbortError'
      ? `Web search timed out after ${Math.round(SEARCH_TIMEOUT_MS / 1000)}s`
      : error.message;
    return { ok: false, reason, results: [], answer: '' };
  } finally {
    clearTimeout(timer);
  }
}

module.exports = {
  searchWeb,
  isWebSearchEnabled,
  webSearchStatus
};
