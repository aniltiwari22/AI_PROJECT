import React from 'react';
import { FiCheck, FiX, FiLoader, FiTarget, FiClock, FiZap } from 'react-icons/fi';

/**
 * Live execution panel. Shows every pipeline step as it happens, with the time
 * each one took — the difference between "Thinking…" and actually knowing the
 * assistant checked Excel, missed, and then spent 73s in the model.
 */

const STATUS = {
  running: { Icon: FiLoader, cls: 'text-accent animate-spin', row: 'text-content' },
  hit: { Icon: FiTarget, cls: 'text-success', row: 'text-content' },
  done: { Icon: FiCheck, cls: 'text-success', row: 'text-muted' },
  miss: { Icon: FiX, cls: 'text-faint', row: 'text-faint' }
};

function ms(value) {
  if (value === undefined || value === null) return '';
  return value >= 1000 ? `${(value / 1000).toFixed(1)}s` : `${value}ms`;
}

export default function ActivityPanel({ steps = [], totalMs, origin, confidence, live }) {
  const hasContent = steps.length > 0;

  return (
    <div className="flex h-full flex-col gap-3 overflow-y-auto p-3">
      <div className="flex items-center justify-between">
        <h2 className="text-[11px] font-semibold uppercase tracking-wider text-faint">AI Activity</h2>
        {live && <span className="flex items-center gap-1 text-[10px] text-accent"><FiZap className="text-[9px]" /> live</span>}
      </div>

      {!hasContent && (
        <p className="text-xs leading-relaxed text-faint">
          Execution steps appear here — which sources were searched, what hit, and how long each took.
        </p>
      )}

      {hasContent && (
        <ol className="space-y-1.5">
          {steps.map((s, i) => {
            const meta = STATUS[s.status] || STATUS.done;
            const { Icon } = meta;
            return (
              <li key={`${s.key}-${i}`} className={`flex items-start gap-2 text-xs ${meta.row}`}>
                <Icon className={`mt-0.5 shrink-0 text-[11px] ${meta.cls}`} />
                <span className="min-w-0 flex-1">
                  <span className="block truncate">{s.label}</span>
                  {s.detail && <span className="block truncate text-[10px] text-faint">{s.detail}</span>}
                </span>
                {s.ms > 0 && <span className="shrink-0 font-mono text-[10px] text-faint">{ms(s.ms)}</span>}
              </li>
            );
          })}
        </ol>
      )}

      {totalMs !== undefined && totalMs !== null && (
        <div className="mt-auto space-y-1.5 border-t border-line pt-3 text-[11px]">
          <div className="flex items-center justify-between">
            <span className="flex items-center gap-1.5 text-faint"><FiClock className="text-[10px]" /> Total</span>
            <span className="font-mono text-content">{ms(totalMs)}</span>
          </div>
          {origin && (
            <div className="flex items-center justify-between">
              <span className="text-faint">Answered by</span>
              <span className="font-medium text-content">{origin}</span>
            </div>
          )}
          {typeof confidence === 'number' && (
            <div className="flex items-center justify-between">
              <span className="text-faint">Confidence</span>
              <span className={`font-mono ${confidence >= 0.9 ? 'text-success' : confidence >= 0.75 ? 'text-warm' : 'text-faint'}`}>
                {Math.round(confidence * 100)}%
              </span>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
