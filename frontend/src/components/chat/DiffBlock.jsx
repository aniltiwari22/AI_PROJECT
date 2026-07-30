import React, { useState } from 'react';
import { FiCopy, FiCheck, FiGitCommit } from 'react-icons/fi';

/**
 * Renders a unified diff with per-line colouring.
 *
 * A change to code you already have is far easier to read as a diff than as a
 * wall of replacement code you have to compare by eye. Nothing here writes to
 * disk — the diff is for reading and copying, and applying it stays your call
 * in your own editor.
 */

// Counts only real edits: the ---/+++ file headers also start with - and +.
function summarise(lines) {
  let added = 0;
  let removed = 0;

  for (const line of lines) {
    if (line.startsWith('+++') || line.startsWith('---')) continue;
    if (line.startsWith('+')) added += 1;
    else if (line.startsWith('-')) removed += 1;
  }

  return { added, removed };
}

function classFor(line) {
  if (line.startsWith('+++') || line.startsWith('---')) return 'text-faint';
  if (line.startsWith('@@')) return 'bg-accent/10 text-accent';
  if (line.startsWith('+')) return 'bg-success/10 text-success';
  if (line.startsWith('-')) return 'bg-danger/10 text-danger';
  return 'text-muted';
}

// Strips the leading marker so the copied text is code, not a diff, when the
// user only wants the new version.
function withoutMarkers(lines) {
  return lines
    .filter((l) => !l.startsWith('-') && !l.startsWith('@@'))
    .map((l) => (l.startsWith('+') && !l.startsWith('+++') ? l.slice(1) : l))
    .join('\n');
}

export default function DiffBlock({ content }) {
  const [copied, setCopied] = useState(null);

  const lines = String(content).replace(/\n$/, '').split('\n');
  const { added, removed } = summarise(lines);

  const copy = async (text, which) => {
    try {
      await navigator.clipboard.writeText(text);
      setCopied(which);
      setTimeout(() => setCopied(null), 1600);
    } catch {
      // clipboard unavailable (insecure origin / permission denied)
    }
  };

  return (
    <div className="group/diff my-3 overflow-hidden rounded-xl border border-line bg-surface/80 shadow-sm first:mt-0 last:mb-0">
      <div className="flex items-center justify-between gap-2 border-b border-line bg-surface-strong/60 px-3 py-1.5">
        <div className="flex items-center gap-2">
          <FiGitCommit className="text-xs text-accent" />
          <span className="font-mono text-[10px] uppercase tracking-wider text-faint">diff</span>
          {(added > 0 || removed > 0) && (
            <span className="font-mono text-[10px]">
              {added > 0 && <span className="text-success">+{added}</span>}
              {added > 0 && removed > 0 && <span className="text-faint"> </span>}
              {removed > 0 && <span className="text-danger">−{removed}</span>}
            </span>
          )}
        </div>

        <div className="flex items-center gap-0.5 opacity-0 transition group-hover/diff:opacity-100 focus-within:opacity-100">
          <button
            type="button"
            onClick={() => copy(withoutMarkers(lines), 'result')}
            title="Copy the changed code, without the +/- markers"
            className="rounded px-1.5 py-1 text-[10px] font-medium text-faint transition hover:bg-surface-strong hover:text-content"
          >
            {copied === 'result' ? <FiCheck className="inline text-success" /> : 'Copy result'}
          </button>
          <button
            type="button"
            onClick={() => copy(String(content), 'diff')}
            title="Copy the diff exactly as shown"
            className="flex items-center gap-1 rounded px-1.5 py-1 text-[10px] font-medium text-faint transition hover:bg-surface-strong hover:text-content"
          >
            {copied === 'diff' ? <FiCheck className="text-success" /> : <FiCopy />}
            {copied === 'diff' ? 'Copied' : 'Copy diff'}
          </button>
        </div>
      </div>

      <div className="overflow-x-auto">
        <pre className="py-2 font-mono text-xs leading-[1.65]">
          <code>
            {lines.map((line, index) => (
              <div key={index} className={`px-3 ${classFor(line)}`}>
                {/* A no-break space keeps blank lines from collapsing the row. */}
                {line || ' '}
              </div>
            ))}
          </code>
        </pre>
      </div>
    </div>
  );
}
