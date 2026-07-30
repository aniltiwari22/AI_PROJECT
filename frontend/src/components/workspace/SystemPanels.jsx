import React from 'react';
import { FiCpu, FiHardDrive, FiDatabase, FiBox, FiActivity, FiAlertCircle } from 'react-icons/fi';

/**
 * The right-hand dashboard column.
 *
 * Every number here comes from something that measured it. Where a reading
 * genuinely does not exist on this machine — GPU utilisation, total drive
 * capacity — it says so instead of showing a plausible figure. A dashboard
 * whose numbers you cannot trust is worse than no dashboard.
 */

function gb(bytes) {
  if (!bytes) return '0 GB';
  const value = bytes / 1024 ** 3;
  return value < 0.1 ? `${(bytes / 1024 ** 2).toFixed(0)} MB` : `${value.toFixed(1)} GB`;
}

/** Inline sparkline. No chart library — it is sixty numbers in a row. */
function Spark({ points, className = 'text-accent' }) {
  if (!points || points.length < 2) {
    return <div className="h-8 w-full rounded bg-surface/60" />;
  }

  const clean = points.filter((p) => typeof p === 'number');
  if (clean.length < 2) return <div className="h-8 w-full rounded bg-surface/60" />;

  const max = Math.max(...clean, 100);
  const step = 100 / (clean.length - 1);
  const path = clean.map((p, i) => `${i * step},${32 - (p / max) * 30}`).join(' ');

  return (
    <svg viewBox="0 0 100 32" preserveAspectRatio="none" className={`h-8 w-full ${className}`}>
      <polyline points={path} fill="none" stroke="currentColor" strokeWidth="1.5"
        vectorEffect="non-scaling-stroke" strokeLinejoin="round" strokeLinecap="round" />
    </svg>
  );
}

function Metric({ icon: Icon, label, value, sub, points, tone = 'text-accent' }) {
  return (
    <div className="rounded-xl border border-line bg-surface/40 p-2.5">
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0">
          <p className="flex items-center gap-1.5 text-[10px] text-faint">
            <Icon className="shrink-0" />
            {label}
          </p>
          <p className="mt-0.5 text-sm font-semibold text-content">{value}</p>
          {sub && <p className="truncate text-[10px] text-faint">{sub}</p>}
        </div>
        {points && <div className="w-20 shrink-0"><Spark points={points} className={tone} /></div>}
      </div>
    </div>
  );
}

export function SystemOverview({ system }) {
  if (!system) return null;

  const cpu = system.cpu?.percent;
  const mem = system.memory;

  return (
    <section>
      <h2 className="mb-2 flex items-center gap-1.5 text-[11px] font-semibold uppercase tracking-wider text-muted">
        <FiActivity className="text-xs" /> System
      </h2>

      <div className="space-y-1.5">
        <Metric
          icon={FiCpu}
          label={`CPU · ${system.cpu?.cores || '?'} cores`}
          value={cpu == null ? 'measuring…' : `${cpu}%`}
          points={system.cpu?.history}
        />
        <Metric
          icon={FiHardDrive}
          label="Memory"
          value={mem ? `${mem.percent}%` : '—'}
          sub={mem ? `${mem.usedGb} of ${mem.totalGb} GB` : ''}
          points={mem?.history}
          tone="text-accent-strong"
        />

        {/* Stated, not hidden: a blank card reads like a broken sensor. */}
        <div className="rounded-xl border border-dashed border-line px-2.5 py-2">
          <p className="text-[10px] text-faint">
            <span className="font-medium text-muted">GPU</span> — not available.{' '}
            {system.gpu?.reason || 'Inference runs on the CPU.'}
          </p>
        </div>

        {system.process && (
          <p className="px-1 text-[10px] text-faint">
            up {Math.floor(system.process.uptimeSec / 3600)}h {Math.floor((system.process.uptimeSec % 3600) / 60)}m
            {' · '}heap {system.process.heapMb} MB
          </p>
        )}
      </div>
    </section>
  );
}

export function ModelsLoaded({ models }) {
  if (!models?.length) return null;

  const resident = models.filter((m) => m.loaded);

  return (
    <section>
      <h2 className="mb-2 flex items-center justify-between text-[11px] font-semibold uppercase tracking-wider text-muted">
        <span className="flex items-center gap-1.5"><FiBox className="text-xs" /> Models</span>
        <span className="font-mono text-[10px] normal-case text-faint">
          {resident.length} of {models.length} loaded
        </span>
      </h2>

      <div className="space-y-1">
        {models.map((m) => (
          <div
            key={m.name}
            className="flex items-center gap-2 rounded-lg border border-line bg-surface/40 px-2.5 py-1.5"
            title={m.loaded ? 'Resident in memory now' : 'On disk, not loaded'}
          >
            <span className={`h-1.5 w-1.5 shrink-0 rounded-full ${m.loaded ? 'bg-success' : 'bg-line-strong'}`} />
            <span className="min-w-0 flex-1">
              <span className="block truncate text-[11px] font-medium text-content">{m.name}</span>
              {m.isDefault && <span className="text-[10px] text-accent">default</span>}
            </span>
            <span className="shrink-0 font-mono text-[10px] text-faint">
              {m.sizeGb != null ? `${m.sizeGb} GB` : ''}
            </span>
          </div>
        ))}
      </div>
    </section>
  );
}

export function StorageBreakdown({ storage }) {
  if (!storage?.categories?.length) return null;

  const total = storage.usedBytes || 1;
  const colours = ['bg-accent', 'bg-accent-strong', 'bg-success', 'bg-warm'];

  return (
    <section>
      <h2 className="mb-2 flex items-center justify-between text-[11px] font-semibold uppercase tracking-wider text-muted">
        <span className="flex items-center gap-1.5"><FiDatabase className="text-xs" /> Storage</span>
        <span className="font-mono text-[10px] normal-case text-faint">{gb(storage.usedBytes)}</span>
      </h2>

      {/* A bar, not a donut: these are parts of what this app uses, and the
          drive's total capacity is not something Node reports portably. */}
      <div className="mb-2 flex h-2 overflow-hidden rounded-full bg-surface">
        {storage.categories.map((c, i) => (
          c.bytes > 0 && (
            <div
              key={c.key}
              className={colours[i % colours.length]}
              style={{ width: `${(c.bytes / total) * 100}%` }}
              title={`${c.label}: ${gb(c.bytes)}`}
            />
          )
        ))}
      </div>

      <div className="space-y-0.5">
        {storage.categories.map((c, i) => (
          <div key={c.key} className="flex items-center gap-2 text-[10px]">
            <span className={`h-1.5 w-1.5 shrink-0 rounded-full ${colours[i % colours.length]}`} />
            <span className="flex-1 text-muted">{c.label}</span>
            <span className="font-mono text-faint">{gb(c.bytes)}</span>
          </div>
        ))}
      </div>

      <p className="mt-2 flex items-start gap-1 text-[10px] leading-snug text-faint">
        <FiAlertCircle className="mt-0.5 shrink-0" />
        What this app uses. Total drive capacity is not shown because it is not
        reliably measurable here.
      </p>
    </section>
  );
}
