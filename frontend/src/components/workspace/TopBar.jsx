import React from 'react';
import { FiCpu, FiHardDrive } from 'react-icons/fi';

/**
 * Every chip here is driven by /health — a subsystem shows as online only if
 * it reported itself online. Chips that are always green are decoration, and
 * decoration is exactly what you cannot trust when something breaks.
 */
function toolsFrom(health) {
  if (!health) return [];

  return [
    { key: 'ollama', label: 'Ollama', ok: Boolean(health.ollama?.connected), detail: health.ollama?.model },
    {
      key: 'excel',
      label: 'Excel',
      ok: !health.excel?.error && (health.excel?.totalRows || 0) > 0,
      detail: health.excel?.error
        ? health.excel.error
        : health.excel?.totalRows
          ? `${health.excel.totalRows} rows`
          : 'workbook has no rows yet'
    },
    { key: 'knowledge', label: 'Knowledge', ok: (health.knowledge?.documents || 0) > 0, detail: `${health.knowledge?.documents || 0} docs` },
    { key: 'web', label: 'Web', ok: Boolean(health.webSearch?.enabled), detail: health.webSearch?.enabled ? 'Tavily' : 'no API key' },
    { key: 'vision', label: 'Vision', ok: Boolean(health.vision?.enabled), detail: health.vision?.model },
    { key: 'cache', label: 'Cache', ok: (health.cache?.entries || 0) > 0, detail: `${health.cache?.entries || 0} cached` }
  ];
}

function Metric({ icon: Icon, label, value, title }) {
  if (value == null) return null;
  return (
    <span
      title={title}
      className="hidden items-center gap-1.5 rounded-lg border border-line bg-surface/50 px-2 py-1 text-[11px] text-muted xl:flex"
    >
      <Icon className="text-xs text-faint" />
      <span className="font-mono">{label}</span>
      <span className="font-medium text-content">{value}</span>
    </span>
  );
}

export default function TopBar({ health, system, right }) {
  const tools = toolsFrom(health);

  return (
    <div className="flex h-12 shrink-0 items-center gap-3 border-b border-line bg-bg-elevated/60 px-4 backdrop-blur">
      <span className="flex shrink-0 items-center gap-1.5 rounded-lg border border-success/30 bg-success/10 px-2 py-1 text-[10px] font-semibold uppercase tracking-wider text-success">
        <span className="h-1.5 w-1.5 rounded-full bg-success" />
        Local
      </span>

      <div className="flex min-w-0 flex-1 items-center gap-1.5 overflow-x-auto">
        {tools.map((t) => (
          <span
            key={t.key}
            title={`${t.label}: ${t.ok ? 'online' : 'unavailable'}${t.detail ? ` · ${t.detail}` : ''}`}
            className={`flex shrink-0 items-center gap-1.5 rounded-lg border px-2 py-1 text-[11px] transition ${
              t.ok
                ? 'border-line bg-surface/50 text-muted'
                : 'border-transparent bg-transparent text-faint/60'
            }`}
          >
            <span className={`h-1.5 w-1.5 rounded-full ${t.ok ? 'bg-success' : 'bg-line-strong'}`} />
            {t.label}
          </span>
        ))}
      </div>

      {/* Real readings only. There is no GPU on this machine, so no GPU gauge. */}
      <Metric
        icon={FiCpu}
        label="CPU"
        value={system?.cpu?.percent != null ? `${system.cpu.percent}%` : null}
        title={system?.cpu?.cores ? `${system.cpu.cores} cores · ${system.gpu?.reason || ''}` : ''}
      />
      <Metric
        icon={FiHardDrive}
        label="RAM"
        value={system?.memory ? `${system.memory.usedGb}/${system.memory.totalGb}GB` : null}
        title={system?.memory ? `${system.memory.percent}% used` : ''}
      />

      {right}
    </div>
  );
}
