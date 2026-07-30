import React, { useState } from 'react';
import { FiGlobe, FiDatabase, FiCpu, FiExternalLink, FiChevronDown, FiPaperclip, FiGrid, FiZap } from 'react-icons/fi';

const ORIGIN_META = {
  internal: { label: 'Internal data', Icon: FiDatabase, tone: 'border-accent/30 bg-accent/10 text-accent' },
  web: { label: 'Web', Icon: FiGlobe, tone: 'border-success/30 bg-success/10 text-success' },
  model: { label: 'Model knowledge', Icon: FiCpu, tone: 'border-line-strong bg-surface text-muted' },
  file: { label: 'Attached file', Icon: FiPaperclip, tone: 'border-warm/30 bg-warm/10 text-warm' },
  excel: { label: 'Excel', Icon: FiGrid, tone: 'border-success/40 bg-success/15 text-success' },
  cache: { label: 'Cached', Icon: FiZap, tone: 'border-accent/30 bg-accent/10 text-accent' }
};

function hostOf(url) {
  try {
    return new URL(url).hostname.replace(/^www\./, '');
  } catch {
    return url;
  }
}

export default function SourceList({ origin, sources = [], confidence }) {
  const [open, setOpen] = useState(false);

  // Greetings carry no provenance worth showing.
  const meta = ORIGIN_META[origin];
  if (!meta) return null;

  const { label, Icon, tone } = meta;
  const hasSources = sources.length > 0;

  return (
    <span className="inline-flex flex-col gap-1.5">
      <span className="flex items-center gap-1.5">
        <span className={`inline-flex items-center gap-1.5 rounded-lg border px-2 py-0.5 text-[11px] font-medium ${tone}`}>
          <Icon className="text-[10px]" />
          {label}
        </span>

        {hasSources && (
          <button
            type="button"
            onClick={() => setOpen((v) => !v)}
            aria-expanded={open}
            className="inline-flex items-center gap-1 rounded-lg px-1.5 py-0.5 text-[11px] text-faint transition hover:text-content"
          >
            {sources.length} source{sources.length > 1 ? 's' : ''}
            <FiChevronDown className={`transition-transform ${open ? 'rotate-180' : ''}`} />
          </button>
        )}

        {typeof confidence === 'number' && (
          // Confidence is what tells a curated Excel row apart from a model guess.
          <span
            title={'Confidence ' + Math.round(confidence * 100) + '%'}
            className={'text-[11px] font-medium ' + (confidence >= 0.9 ? 'text-success' : confidence >= 0.75 ? 'text-warm' : 'text-faint')}
          >
            {Math.round(confidence * 100)}%
          </span>
        )}

        {origin === 'model' && <span className="text-[11px] text-faint">unverified</span>}
      </span>

      {open && hasSources && (
        <ol className="animate-fade-in space-y-1.5 rounded-xl border border-line bg-surface/70 p-2.5">
          {sources.map((source, index) => (
            <li key={`${source.url || source.title}-${index}`} className="flex items-start gap-2 text-[11px]">
              <span className="mt-0.5 shrink-0 font-mono text-faint">{index + 1}</span>

              {source.url ? (
                <a href={source.url} target="_blank" rel="noreferrer noopener" className="group/src min-w-0 flex-1">
                  <span className="block truncate text-muted underline-offset-2 group-hover/src:text-accent group-hover/src:underline">
                    {source.title}
                  </span>
                  <span className="flex items-center gap-1 text-faint">
                    {hostOf(source.url)}
                    <FiExternalLink className="text-[9px]" />
                  </span>
                </a>
              ) : (
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-muted">{source.title}</span>
                  {source.reference && <span className="text-faint">{source.reference}</span>}
                </span>
              )}

              {typeof source.score === 'number' && (
                <span className="shrink-0 font-mono text-[10px] text-faint">{source.score.toFixed(2)}</span>
              )}
            </li>
          ))}
        </ol>
      )}
    </span>
  );
}
