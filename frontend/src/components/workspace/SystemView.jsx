import React, { useEffect, useState, useCallback } from 'react';
import { FiRefreshCw, FiAlertTriangle, FiCheckCircle, FiXCircle } from 'react-icons/fi';
import { fetchEngineHealth, fetchAnalytics } from '../../services/service1';

/**
 * Health monitor and benchmark view. Both read data the system already
 * produces — /health for live subsystem state, and the Excel request log for
 * historical performance — so nothing extra is recorded to power this page.
 */

function statusOf(key, value) {
  if (!value || typeof value !== 'object') return { ok: false, note: 'not reported' };
  if (value.error) return { ok: false, note: value.error };

  switch (key) {
    case 'database':
      return { ok: Boolean(value.connected), note: `${value.chatLogCount ?? 0} chat logs` };
    case 'ollama':
      return {
        ok: Boolean(value.connected),
        note: value.connected ? `${value.model}${value.modelAvailable ? '' : ' (model missing)'}` : 'unreachable'
      };
    case 'telegram':
      return { ok: Boolean(value.running), note: value.enabled ? (value.running ? 'polling' : 'stopped') : 'disabled' };
    case 'webSearch':
      return { ok: Boolean(value.enabled), note: value.enabled ? value.provider : 'no API key' };
    case 'vision':
      return { ok: Boolean(value.enabled), note: value.model };
    case 'knowledge':
      return { ok: (value.chunks ?? 0) > 0, note: `${value.documents ?? 0} docs · ${value.chunks ?? 0} chunks` };
    case 'excel':
      return { ok: (value.totalRows ?? 0) > 0, note: `${value.totalRows ?? 0} rows · ${(value.sheets || []).length} sheets` };
    case 'cache':
      return { ok: (value.entries ?? 0) > 0, note: `${value.entries ?? 0} entries · ${value.totalHits ?? 0} hits` };
    case 'logs':
      return { ok: (value.sheets || []).length > 0, note: (value.sheets || []).map((s) => s.name).join(', ') || 'no sheets yet' };
    default:
      return { ok: true, note: '' };
  }
}

const ORDER = ['ollama', 'database', 'excel', 'knowledge', 'cache', 'vision', 'webSearch', 'telegram', 'logs'];
const LABEL = {
  ollama: 'Ollama', database: 'Database', excel: 'Excel knowledge', knowledge: 'Vector knowledge',
  cache: 'Semantic cache', vision: 'Vision model', webSearch: 'Web search', telegram: 'Telegram bot', logs: 'Excel logs'
};

function Bar({ value, max, tone = 'bg-accent' }) {
  const pct = max > 0 ? Math.round((value / max) * 100) : 0;
  return (
    <span className="block h-1.5 w-full overflow-hidden rounded-full bg-surface-strong">
      <span className={`block h-full rounded-full ${tone}`} style={{ width: `${pct}%` }} />
    </span>
  );
}

export default function SystemView({ tab }) {
  const [health, setHealth] = useState(null);
  const [analytics, setAnalytics] = useState(null);
  const [loading, setLoading] = useState(true);

  const load = useCallback(async () => {
    setLoading(true);
    const [h, a] = await Promise.all([fetchEngineHealth(), fetchAnalytics()]);
    setHealth(h.raw || null);
    setAnalytics(a);
    setLoading(false);
  }, []);

  useEffect(() => { load(); }, [load]);

  const maxOrigin = analytics?.origins?.reduce((m, o) => Math.max(m, o.count), 0) || 0;

  return (
    <div className="mx-auto max-w-3xl space-y-5 px-4 py-8">
      <div className="flex items-center gap-3">
        <h1 className="text-lg font-semibold tracking-tight">
          {tab === 'analytics' ? 'Benchmark' : 'Health monitor'}
        </h1>
        <button
          type="button"
          onClick={load}
          className="ml-auto flex items-center gap-1.5 rounded-lg border border-line px-2 py-1 text-[11px] text-muted transition hover:text-content"
        >
          <FiRefreshCw className={loading ? 'animate-spin' : ''} /> Refresh
        </button>
      </div>

      {tab !== 'analytics' && (
        <div className="space-y-1.5">
          {ORDER.map((key) => {
            const s = statusOf(key, health?.[key]);
            const Icon = s.ok ? FiCheckCircle : health?.[key]?.error ? FiXCircle : FiAlertTriangle;
            return (
              <div key={key} className="flex items-center gap-3 rounded-xl border border-line bg-surface/50 px-3 py-2">
                <Icon className={`shrink-0 text-sm ${s.ok ? 'text-success' : health?.[key]?.error ? 'text-danger' : 'text-warm'}`} />
                <span className="w-36 shrink-0 text-sm text-content">{LABEL[key]}</span>
                <span className="min-w-0 flex-1 truncate text-xs text-faint">{s.note}</span>
                <span className={`shrink-0 text-[11px] font-medium ${s.ok ? 'text-success' : 'text-faint'}`}>
                  {s.ok ? 'ready' : 'idle'}
                </span>
              </div>
            );
          })}
        </div>
      )}

      {tab === 'analytics' && (
        <>
          {analytics?.empty && (
            <p className="rounded-xl border border-line bg-surface/50 p-4 text-sm text-muted">
              No requests logged yet. Ask a question and the numbers appear here.
            </p>
          )}

          {analytics?.totals && (
            <>
              <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
                {[
                  ['Requests', analytics.totals.requests],
                  ['Avg latency', `${analytics.totals.avgSeconds}s`],
                  ['Median', `${analytics.totals.medianSeconds}s`],
                  ['Instant', `${analytics.totals.instantRate}%`]
                ].map(([label, value]) => (
                  <div key={label} className="rounded-xl border border-line bg-surface/50 p-3">
                    <div className="text-[11px] text-faint">{label}</div>
                    <div className="mt-0.5 text-lg font-semibold tabular-nums text-content">{value}</div>
                  </div>
                ))}
              </div>

              <div className="rounded-xl border border-line bg-surface/50 p-3">
                <h2 className="mb-2.5 text-[11px] font-semibold uppercase tracking-wider text-faint">
                  Where answers came from
                </h2>
                <div className="space-y-2">
                  {analytics.origins.map((o) => (
                    <div key={o.origin} className="space-y-1">
                      <div className="flex items-baseline gap-2 text-xs">
                        <span className="w-20 shrink-0 text-content">{o.origin}</span>
                        <span className="font-mono text-faint">{o.count}×</span>
                        <span className="ml-auto font-mono text-faint">avg {o.avgSeconds}s</span>
                        <span className="w-12 shrink-0 text-right font-mono text-muted">{o.share}%</span>
                      </div>
                      <Bar
                        value={o.count}
                        max={maxOrigin}
                        tone={['excel', 'cache', 'greeting'].includes(o.origin) ? 'bg-success' : 'bg-accent'}
                      />
                    </div>
                  ))}
                </div>
                <p className="mt-2.5 border-t border-line pt-2 text-[11px] text-faint">
                  Green sources answer without calling a model.
                </p>
              </div>

              {analytics.topQuestions?.length > 0 && (
                <div className="rounded-xl border border-line bg-surface/50 p-3">
                  <h2 className="mb-2 text-[11px] font-semibold uppercase tracking-wider text-faint">Most asked</h2>
                  <ol className="space-y-1">
                    {analytics.topQuestions.map((q, i) => (
                      <li key={i} className="flex items-baseline gap-2 text-xs">
                        <span className="font-mono text-faint">{q.count}×</span>
                        <span className="min-w-0 flex-1 truncate text-muted">{q.question}</span>
                      </li>
                    ))}
                  </ol>
                </div>
              )}
            </>
          )}
        </>
      )}
    </div>
  );
}
