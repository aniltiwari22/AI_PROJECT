import React, { useState } from 'react';
import { FiChevronDown, FiClock, FiHash, FiCpu, FiCode, FiLayers } from 'react-icons/fi';

/**
 * Per-message inspector — "Chrome DevTools for AI".
 *
 * Everything here is real data captured during the request, not a summary:
 * the exact system prompt sent, token counts reported by Ollama, and the
 * timing of every pipeline step. Replay works because the timeline is stored
 * on the message, so any past answer can be re-examined.
 */

const STATUS_TONE = {
  hit: 'text-success',
  done: 'text-muted',
  miss: 'text-faint',
  running: 'text-accent'
};

function ms(v) {
  if (v === undefined || v === null) return '—';
  return v >= 1000 ? `${(v / 1000).toFixed(2)}s` : `${v}ms`;
}

function Stat({ label, value, mono = true }) {
  return (
    <div className="flex items-center justify-between gap-3 py-0.5">
      <span className="text-faint">{label}</span>
      <span className={`${mono ? 'font-mono' : ''} text-content`}>{value}</span>
    </div>
  );
}

function Section({ icon: Icon, title, children, defaultOpen = false }) {
  const [open, setOpen] = useState(defaultOpen);
  return (
    <div className="rounded-lg border border-line">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        className="flex w-full items-center gap-2 px-2.5 py-1.5 text-[11px] font-medium text-muted transition hover:text-content"
      >
        <Icon className="text-[11px] text-accent" />
        {title}
        <FiChevronDown className={`ml-auto transition-transform ${open ? 'rotate-180' : ''}`} />
      </button>
      {open && <div className="border-t border-line px-2.5 py-2 text-[11px]">{children}</div>}
    </div>
  );
}

export default function DevTools({ message }) {
  const [open, setOpen] = useState(false);

  const timeline = message.timeline || [];
  const t = message.telemetry || null;
  const hasAnything = timeline.length > 0 || t || message.totalMs !== undefined;
  if (!hasAnything) return null;

  const tokensPerSec =
    t?.outputTokens && t?.generateMs ? (t.outputTokens / (t.generateMs / 1000)).toFixed(1) : null;

  return (
    <div className="mt-1.5 w-full">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        className="flex items-center gap-1 rounded-lg px-1.5 py-0.5 text-[10px] text-faint transition hover:bg-surface hover:text-content"
      >
        <FiLayers className="text-[10px]" />
        Inspect
        <FiChevronDown className={`transition-transform ${open ? 'rotate-180' : ''}`} />
      </button>

      {open && (
        <div className="animate-fade-in mt-1.5 space-y-1.5 rounded-xl border border-line bg-surface/60 p-2">
          <Section icon={FiClock} title="Execution timeline" defaultOpen>
            {timeline.length === 0 ? (
              <p className="text-faint">No steps recorded.</p>
            ) : (
              <ol className="space-y-1">
                {timeline.map((s, i) => (
                  <li key={`${s.key}-${i}`} className="flex items-baseline gap-2">
                    <span className="w-14 shrink-0 text-right font-mono text-faint">+{ms(s.at)}</span>
                    <span className={`w-10 shrink-0 ${STATUS_TONE[s.status] || 'text-muted'}`}>{s.status}</span>
                    <span className="min-w-0 flex-1 truncate text-content">
                      {s.label}
                      {s.detail && <span className="text-faint"> — {s.detail}</span>}
                    </span>
                    {s.ms > 0 && <span className="shrink-0 font-mono text-faint">{ms(s.ms)}</span>}
                  </li>
                ))}
              </ol>
            )}
            <div className="mt-1.5 border-t border-line pt-1.5">
              <Stat label="Total" value={ms(message.totalMs)} />
            </div>
          </Section>

          <Section icon={FiHash} title="Tokens & cost">
            {t ? (
              <>
                <Stat label="Model" value={t.model} />
                <Stat label="Prompt tokens" value={t.promptTokens ?? '—'} />
                <Stat label="Output tokens" value={t.outputTokens ?? '—'} />
                <Stat label="Prompt eval" value={ms(t.promptMs)} />
                <Stat label="Generation" value={ms(t.generateMs)} />
                {t.loadMs > 0 && <Stat label="Model load" value={ms(t.loadMs)} />}
                {tokensPerSec && <Stat label="Throughput" value={`${tokensPerSec} tok/s`} />}
                <Stat label="Context window" value={t.numCtx} />
                <Stat label="Output cap" value={t.numPredict} />
              </>
            ) : (
              // Excel and cache hits never call a model — zero tokens is the win.
              <p className="text-success">No model call — answered directly from a source.</p>
            )}
          </Section>

          {t?.systemPrompt && (
            <Section icon={FiCode} title="Prompt sent">
              <pre className="max-h-52 overflow-auto whitespace-pre-wrap break-words font-mono text-[10px] leading-relaxed text-muted">
                {t.systemPrompt}
              </pre>
              <div className="mt-1.5 border-t border-line pt-1.5">
                <Stat label="Messages in context" value={t.messageCount} />
              </div>
            </Section>
          )}

          {message.sources?.length > 0 && (
            <Section icon={FiCpu} title={`Sources (${message.sources.length})`}>
              <ul className="space-y-1">
                {message.sources.map((s, i) => (
                  <li key={i} className="flex items-baseline gap-2">
                    <span className="font-mono text-faint">{i + 1}</span>
                    <span className="min-w-0 flex-1 truncate text-content">{s.title}</span>
                    {typeof s.score === 'number' && (
                      <span className="shrink-0 font-mono text-faint">{s.score.toFixed(2)}</span>
                    )}
                  </li>
                ))}
              </ul>
            </Section>
          )}
        </div>
      )}
    </div>
  );
}
