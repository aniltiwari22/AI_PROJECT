import React, { useState } from 'react';
import { FiFolder, FiTrash2, FiLoader, FiSearch, FiPlay, FiAlertTriangle } from 'react-icons/fi';

/**
 * Indexing a project folder so questions can be answered from the whole
 * codebase instead of one uploaded file at a time.
 *
 * Preview first, deliberately: embedding runs at roughly 20 files a minute on
 * this hardware, so committing to a large folder without seeing the cost first
 * means an unexplained ten-minute wait.
 */
export default function RepoPanel({ repos, onPreview, onIndex, onRemove, busy, progress, preview }) {
  const [root, setRoot] = useState('');

  const submitPreview = (event) => {
    event.preventDefault();
    if (root.trim() && !busy) onPreview(root.trim());
  };

  return (
    <div className="space-y-3">
      <form onSubmit={submitPreview} className="flex gap-1.5">
        <input
          value={root}
          onChange={(e) => setRoot(e.target.value)}
          placeholder="C:\path\to\your\project"
          spellCheck={false}
          className="min-w-0 flex-1 rounded-lg border border-line bg-surface/60 px-2.5 py-1.5 font-mono text-[11px] text-content placeholder:text-faint focus:border-accent/50 focus:outline-none"
        />
        <button
          type="submit"
          disabled={!root.trim() || busy}
          className="flex shrink-0 items-center gap-1 rounded-lg border border-line px-2.5 py-1.5 text-[11px] font-medium text-muted transition hover:border-accent/50 hover:text-content disabled:cursor-not-allowed disabled:opacity-40"
        >
          <FiSearch className="text-xs" /> Check
        </button>
      </form>

      {preview && (
        <div className="rounded-lg border border-line bg-surface/40 p-2.5 text-[11px]">
          <p className="font-mono text-[10px] text-faint">{preview.root}</p>
          <p className="mt-1 text-content">
            <span className="font-semibold">{preview.files}</span> files ·{' '}
            <span className="font-semibold">~{preview.estimatedChunks}</span> chunks ·{' '}
            {(preview.bytes / 1024).toFixed(0)} KB
          </p>
          {/* Roughly 20 files a minute measured on this machine. */}
          <p className="mt-0.5 text-faint">
            about {Math.max(1, Math.round(preview.files / 20))} min to index
          </p>

          {preview.truncated && (
            <p className="mt-1.5 flex items-start gap-1 text-warm">
              <FiAlertTriangle className="mt-0.5 shrink-0" />
              Hit the file cap — only the first {preview.files} will be indexed.
            </p>
          )}

          <button
            type="button"
            onClick={() => onIndex(preview.root)}
            disabled={busy || !preview.files}
            className="mt-2 flex w-full items-center justify-center gap-1.5 rounded-lg bg-gradient-to-r from-accent to-accent-strong px-2 py-1.5 text-[11px] font-semibold text-accent-contrast transition hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-40"
          >
            {busy ? <FiLoader className="animate-spin" /> : <FiPlay />}
            {busy ? 'Indexing…' : `Index ${preview.files} files`}
          </button>
        </div>
      )}

      {busy && progress && (
        <div className="rounded-lg border border-accent/30 bg-accent/5 p-2.5">
          <div className="flex items-baseline justify-between text-[10px]">
            <span className="truncate font-mono text-muted" title={progress.file}>{progress.file}</span>
            <span className="shrink-0 pl-2 text-faint">{progress.done}/{progress.total}</span>
          </div>
          <div className="mt-1.5 h-1 overflow-hidden rounded-full bg-line">
            <div
              className="h-full rounded-full bg-accent transition-all"
              style={{ width: `${Math.round((progress.done / progress.total) * 100)}%` }}
            />
          </div>
        </div>
      )}

      {repos.length > 0 && (
        <div className="space-y-1">
          <p className="text-[10px] font-semibold uppercase tracking-wider text-faint">Indexed</p>
          {repos.map((repo) => (
            <div
              key={repo.root}
              className="group/repo flex items-center gap-2 rounded-lg border border-line bg-surface/40 px-2.5 py-1.5"
            >
              <FiFolder className="shrink-0 text-xs text-accent" />
              <div className="min-w-0 flex-1">
                <p className="truncate text-[11px] font-medium text-content" title={repo.root}>{repo.name}</p>
                <p className="truncate text-[10px] text-faint">{repo.files} files · {repo.chunks} chunks</p>
              </div>
              <button
                type="button"
                onClick={() => onRemove(repo.root)}
                aria-label={`Remove ${repo.name} from the index`}
                className="shrink-0 rounded p-1 text-faint opacity-0 transition hover:text-danger group-hover/repo:opacity-100 focus:opacity-100"
              >
                <FiTrash2 className="text-[11px]" />
              </button>
            </div>
          ))}
        </div>
      )}

      {!repos.length && !preview && (
        <p className="text-[11px] leading-relaxed text-faint">
          Index a project folder to ask questions about the whole codebase. Nothing is written to
          the folder — it is only read.
        </p>
      )}
    </div>
  );
}
