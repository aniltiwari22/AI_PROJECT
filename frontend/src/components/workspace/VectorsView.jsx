import React, { useState, useEffect, useCallback } from 'react';
import {
  FiSearch, FiLoader, FiDatabase, FiZap, FiType, FiLayers, FiTrash2, FiFolder
} from 'react-icons/fi';
import { explainRetrieval, fetchKnowledge, fetchRepos, removeRepo, deleteDocument } from '../../services/service1';

/**
 * Retrieval, made inspectable.
 *
 * A wrong answer has two very different causes: the right passage was never
 * retrieved, or it was retrieved and then ranked below something else. Only the
 * fused list is visible during normal use, so the two are indistinguishable.
 * Showing each retriever's own ranking alongside the fusion separates them.
 */

function ScoreBar({ score, threshold }) {
  if (typeof score !== 'number') return null;
  const pct = Math.max(0, Math.min(100, score * 100));
  const passes = threshold == null || score >= threshold;

  return (
    <div className="h-1 w-14 shrink-0 overflow-hidden rounded-full bg-line">
      <div className={`h-full rounded-full ${passes ? 'bg-success' : 'bg-warm'}`} style={{ width: `${pct}%` }} />
    </div>
  );
}

function ResultRow({ item, threshold, showRrf }) {
  return (
    <div className="flex items-start gap-2 rounded-lg border border-line bg-surface/40 px-2.5 py-1.5">
      <span className="mt-0.5 w-4 shrink-0 text-right font-mono text-[10px] text-faint">{item.rank}</span>

      <div className="min-w-0 flex-1">
        <p className="truncate font-mono text-[11px] text-content" title={item.title}>
          {item.title}
          {item.startLine ? <span className="text-faint">:{item.startLine}-{item.endLine}</span> : null}
        </p>
        <p className="truncate text-[10px] text-faint" title={item.preview}>{item.preview}</p>

        {showRrf && item.retrievers && (
          <p className="mt-0.5 flex gap-1">
            {item.retrievers.map((r) => (
              <span key={r} className={`rounded px-1 text-[9px] ${r === 'vector' ? 'bg-accent/15 text-accent' : 'bg-success/15 text-success'}`}>
                {r}
              </span>
            ))}
            <span className="text-[9px] text-faint">rrf {item.rrf}</span>
          </p>
        )}
      </div>

      <div className="flex shrink-0 items-center gap-1.5">
        <ScoreBar score={item.score} threshold={threshold} />
        <span className="w-9 text-right font-mono text-[10px] text-muted">
          {typeof item.score === 'number' ? item.score.toFixed(2) : '—'}
        </span>
      </div>
    </div>
  );
}

function Column({ title, icon: Icon, items, empty, threshold, showRrf }) {
  return (
    <div className="min-w-0">
      <h3 className="mb-1.5 flex items-center gap-1.5 text-[11px] font-semibold uppercase tracking-wider text-muted">
        <Icon className="text-xs" /> {title}
        <span className="font-mono text-[10px] normal-case text-faint">({items.length})</span>
      </h3>
      <div className="space-y-1">
        {items.length
          ? items.map((item) => (
              <ResultRow key={`${title}-${item.id}`} item={item} threshold={threshold} showRrf={showRrf} />
            ))
          : <p className="rounded-lg border border-dashed border-line px-2.5 py-3 text-[11px] text-faint">{empty}</p>}
      </div>
    </div>
  );
}

export default function VectorsView() {
  const [query, setQuery] = useState('');
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState(null);
  const [knowledge, setKnowledge] = useState(null);
  const [repos, setRepos] = useState([]);

  const refresh = useCallback(async () => {
    const [k, r] = await Promise.all([fetchKnowledge(), fetchRepos()]);
    setKnowledge(k);
    setRepos(r);
  }, []);

  useEffect(() => { refresh(); }, [refresh]);

  const run = async (event) => {
    event.preventDefault();
    if (!query.trim() || busy) return;
    setBusy(true);
    setResult(await explainRetrieval(query.trim()));
    setBusy(false);
  };

  const stats = knowledge?.stats;

  return (
    <div className="mx-auto w-full max-w-4xl space-y-6 px-5 py-8">
      <header>
        <h1 className="text-xl font-semibold tracking-tight text-content">Vectors &amp; retrieval</h1>
        <p className="mt-1 text-xs text-muted">
          What is indexed, and exactly how a question finds it.
        </p>
      </header>

      <section className="grid grid-cols-2 gap-2 sm:grid-cols-4">
        {[
          { label: 'Documents', value: stats?.documents ?? '—', icon: FiDatabase },
          { label: 'Chunks', value: stats?.chunks ?? '—', icon: FiLayers },
          { label: 'Codebases', value: repos.length, icon: FiFolder },
          {
            label: 'Embeddings',
            value: stats?.embeddings?.enabled ? 'on' : 'off',
            icon: FiZap,
            sub: stats?.embeddings?.model
          }
        ].map((s) => (
          <div key={s.label} className="rounded-xl border border-line bg-surface/40 p-3">
            <p className="flex items-center gap-1.5 text-[10px] text-faint"><s.icon /> {s.label}</p>
            <p className="mt-0.5 text-lg font-semibold text-content">{s.value}</p>
            {s.sub && <p className="truncate text-[10px] text-faint">{s.sub}</p>}
          </div>
        ))}
      </section>

      <section>
        <form onSubmit={run} className="flex gap-2">
          <label className="flex min-w-0 flex-1 items-center gap-2 rounded-xl border border-line bg-surface/60 px-3 py-2 focus-within:border-accent/50">
            <FiSearch className="shrink-0 text-sm text-faint" />
            <span className="sr-only">Test a query</span>
            <input
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="Try a question, or a literal like timingSafeEqual"
              className="min-w-0 flex-1 bg-transparent text-sm text-content placeholder:text-faint focus:outline-none"
            />
          </label>
          <button
            type="submit"
            disabled={!query.trim() || busy}
            className="flex shrink-0 items-center gap-1.5 rounded-xl bg-gradient-to-r from-accent to-accent-strong px-4 text-xs font-semibold text-accent-contrast transition hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-40"
          >
            {busy ? <FiLoader className="animate-spin" /> : <FiSearch />} Explain
          </button>
        </form>

        {result?.error && (
          <p className="mt-2 text-[11px] text-danger">{result.error}</p>
        )}

        {result?.empty && (
          <p className="mt-2 rounded-lg border border-dashed border-line px-3 py-4 text-[11px] text-faint">
            {result.reason}. Index a codebase from the Context rail first.
          </p>
        )}

        {result && !result.empty && !result.error && (
          <div className="mt-4 space-y-4">
            <div className="flex flex-wrap items-center gap-x-4 gap-y-1 rounded-lg border border-line bg-surface/40 px-3 py-2 text-[10px] text-faint">
              <span>{result.totalChunks} chunks searched</span>
              <span>embedding {result.embeddings.ms}ms · {result.embeddings.dimensions}d</span>
              <span>tokens: {result.tokens.join(', ') || '(none)'}</span>
              <span className="font-medium text-muted">{result.verdict}</span>
            </div>

            <Column
              title="Fused (what the assistant uses)"
              icon={FiLayers}
              items={result.fused}
              threshold={result.threshold}
              showRrf
              empty="Nothing fused — only one retriever returned results."
            />

            <div className="grid gap-4 md:grid-cols-2">
              <Column
                title="Vector"
                icon={FiZap}
                items={result.vector}
                threshold={result.threshold}
                empty={result.embeddings.available ? 'No vector matches.' : 'Embeddings unavailable.'}
              />
              <Column
                title="Keyword"
                icon={FiType}
                items={result.keyword}
                empty="No keyword matches — the query may be all stop words."
              />
            </div>
          </div>
        )}
      </section>

      {repos.length > 0 && (
        <section>
          <h2 className="mb-2 text-[11px] font-semibold uppercase tracking-wider text-muted">Indexed codebases</h2>
          <div className="space-y-1">
            {repos.map((repo) => (
              <div key={repo.root} className="group/repo flex items-center gap-2 rounded-lg border border-line bg-surface/40 px-3 py-2">
                <FiFolder className="shrink-0 text-xs text-accent" />
                <div className="min-w-0 flex-1">
                  <p className="truncate text-[11px] font-medium text-content">{repo.name}</p>
                  <p className="truncate font-mono text-[10px] text-faint" title={repo.root}>{repo.root}</p>
                </div>
                <span className="shrink-0 font-mono text-[10px] text-faint">
                  {repo.files} files · {repo.chunks} chunks
                </span>
                <button
                  type="button"
                  onClick={async () => { await removeRepo(repo.root); refresh(); }}
                  aria-label={`Remove ${repo.name}`}
                  className="shrink-0 rounded p-1 text-faint opacity-0 transition hover:text-danger group-hover/repo:opacity-100 focus:opacity-100"
                >
                  <FiTrash2 className="text-[11px]" />
                </button>
              </div>
            ))}
          </div>
        </section>
      )}

      {knowledge?.documents?.filter((d) => !String(d.source).startsWith('repo:')).length > 0 && (
        <section>
          <h2 className="mb-2 text-[11px] font-semibold uppercase tracking-wider text-muted">Individual documents</h2>
          <div className="space-y-1">
            {knowledge.documents
              .filter((d) => !String(d.source).startsWith('repo:'))
              .map((doc) => (
                <div key={doc.id} className="group/doc flex items-center gap-2 rounded-lg border border-line bg-surface/40 px-3 py-2">
                  <div className="min-w-0 flex-1">
                    <p className="truncate text-[11px] font-medium text-content">{doc.title}</p>
                    <p className="truncate text-[10px] text-faint">{doc.source}</p>
                  </div>
                  <span className="shrink-0 font-mono text-[10px] text-faint">{doc.chunkCount} chunks</span>
                  <button
                    type="button"
                    onClick={async () => { await deleteDocument(doc.id); refresh(); }}
                    aria-label={`Delete ${doc.title}`}
                    className="shrink-0 rounded p-1 text-faint opacity-0 transition hover:text-danger group-hover/doc:opacity-100 focus:opacity-100"
                  >
                    <FiTrash2 className="text-[11px]" />
                  </button>
                </div>
              ))}
          </div>
        </section>
      )}
    </div>
  );
}
