import React from 'react';

/**
 * What that answer actually cost, under the answer that cost it.
 *
 * The numbers already existed in telemetry but only inside DevTools, which
 * meant the expensive thing about this app — prompt evaluation on CPU — was
 * invisible while you were doing it. Reading a large attachment can take
 * minutes before a single token is generated, and this is where that shows up.
 */
export default function MessageCost({ telemetry, totalMs }) {
  if (!telemetry && !totalMs) return null;

  const t = telemetry || {};
  const parts = [];

  if (t.model) parts.push({ label: String(t.model).split(':')[0], key: 'model' });

  if (t.promptTokens) {
    const rate = t.promptMs ? Math.round(t.promptTokens / (t.promptMs / 1000)) : null;
    parts.push({
      label: `${t.promptTokens.toLocaleString()} in`,
      title: rate ? `Prompt evaluated at ~${rate} tok/s` : 'Prompt tokens',
      key: 'in'
    });
  }

  if (t.outputTokens) {
    const rate = t.generateMs ? (t.outputTokens / (t.generateMs / 1000)).toFixed(1) : null;
    parts.push({
      label: `${t.outputTokens.toLocaleString()} out`,
      title: rate ? `Generated at ~${rate} tok/s` : 'Output tokens',
      key: 'out'
    });
  }

  if (totalMs) {
    parts.push({
      label: totalMs >= 1000 ? `${(totalMs / 1000).toFixed(1)}s` : `${totalMs}ms`,
      title: 'Total time including retrieval',
      key: 'time'
    });
  }

  if (!parts.length) return null;

  return (
    <div className="mt-1.5 flex flex-wrap items-center gap-x-2 gap-y-1 font-mono text-[10px] text-faint">
      {parts.map((p, i) => (
        <React.Fragment key={p.key}>
          {i > 0 && <span className="text-line-strong">·</span>}
          <span title={p.title}>{p.label}</span>
        </React.Fragment>
      ))}
    </div>
  );
}
