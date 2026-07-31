import React from 'react';
import {
  FiFileText, FiImage, FiCode, FiFile, FiX, FiLoader,
  FiAlertTriangle, FiPlus, FiEye
} from 'react-icons/fi';

// Roughly 4 characters per token for English prose and code alike. Exact
// counts only exist server-side after tokenisation, but an estimate shown
// before sending is what stops someone pasting 40k tokens into a 2k window.
const CHARS_PER_TOKEN = 4;

// What the model can actually take in one request — must track OLLAMA_NUM_CTX.
// Past this the backend excerpts the documents down, so the rail warns rather
// than silently trimming. Raised with the window for code work.
const CONTEXT_BUDGET_TOKENS = 8192;

const CODE_EXT = /\.(js|jsx|mjs|cjs|ts|tsx|py|java|kt|go|rs|c|h|cpp|hpp|cc|cs|rb|php|swift|scala|sql|sh|bash|ps1|bat|css|scss|less|vue|svelte|toml|ini|cfg|conf|gradle)$/i;

export function estimateTokens(chars) {
  return Math.ceil((chars || 0) / CHARS_PER_TOKEN);
}

function iconFor(item) {
  if (item.status === 'uploading') return <FiLoader className="animate-spin text-accent" />;
  if (item.status === 'error') return <FiAlertTriangle className="text-danger" />;
  if (item.kind === 'image') return <FiImage className="text-accent" />;
  if (CODE_EXT.test(item.filename || '')) return <FiCode className="text-success" />;
  if (item.kind === 'pdf' || item.kind === 'office') return <FiFileText className="text-warm" />;
  return <FiFile className="text-muted" />;
}

function detailFor(item) {
  if (item.status === 'uploading') {
    return item.kind === 'image' ? 'reading image…' : 'extracting text…';
  }
  if (item.status === 'error') return item.error;

  // The file is usable the moment it is stored; indexing continues behind it,
  // and saying so is better than a progress bar that appears to stall.
  if (item.indexing) return 'ready · indexing for later questions…';

  const bits = [];
  if (item.chars) bits.push(`~${estimateTokens(item.chars).toLocaleString()} tok`);
  if (item.pages) bits.push(`${item.pages}p`);
  if (item.truncated) bits.push('truncated');
  if (item.optimised) bits.push(`${item.optimised.pixelReduction}× smaller`);
  return bits.join(' · ') || 'ready';
}

/**
 * The left rail of the code workspace: everything the assistant can currently
 * see, and what it costs. Attachments used to be transient chips above the
 * composer, which made it impossible to tell at a glance whether a question
 * would actually be answered from your file or from the model guessing.
 */
export default function ContextRail({ items, onRemove, onAdd, onPreview, collapsed, onToggle, repo, hasRepos }) {
  const ready = items.filter((i) => i.status === 'ready');
  const failed = items.filter((i) => i.status === 'error');
  const totalTokens = ready.reduce((sum, i) => sum + estimateTokens(i.chars), 0);
  const over = totalTokens > CONTEXT_BUDGET_TOKENS;
  const fill = Math.min(100, Math.round((totalTokens / CONTEXT_BUDGET_TOKENS) * 100));

  if (collapsed) {
    // With nothing attached and no codebase indexed, an empty strip is just
    // noise — the composer's paperclip is already the way in. It appears once
    // there is something to show or somewhere to get to.
    if (!items.length && !hasRepos) return null;

    return (
      <button
        type="button"
        onClick={onToggle}
        title={items.length
          ? `${ready.length} file${ready.length === 1 ? '' : 's'} in context — click to show`
          : 'Show context and codebase'}
        className="hidden w-10 shrink-0 flex-col items-center gap-2 border-r border-line bg-surface/40 py-3 text-faint transition hover:text-content lg:flex"
      >
        <FiFileText />
        {ready.length > 0 && (
          <span className="rounded-full bg-accent px-1.5 py-0.5 text-[10px] font-bold text-accent-contrast">
            {ready.length}
          </span>
        )}
        {failed.length > 0 && (
          <span className="rounded-full bg-danger px-1.5 py-0.5 text-[10px] font-bold text-white">
            !
          </span>
        )}
      </button>
    );
  }

  return (
    <aside className="hidden w-60 shrink-0 flex-col border-r border-line bg-surface/40 lg:flex">
      <div className="flex items-center justify-between border-b border-line px-3 py-2.5">
        <span className="text-[11px] font-semibold uppercase tracking-wider text-muted">Context</span>
        <button
          type="button"
          onClick={onToggle}
          aria-label="Hide context panel"
          className="rounded p-1 text-faint transition hover:bg-surface-strong hover:text-content"
        >
          <FiX className="text-xs" />
        </button>
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto p-2">
        {!items.length && (
          <p className="px-1 py-3 text-[11px] leading-relaxed text-faint">
            Nothing attached. The assistant is answering from its own knowledge only.
          </p>
        )}

        <div className="space-y-1">
          {items.map((item) => (
            <div
              key={item.key}
              className={`group/item rounded-lg border px-2 py-1.5 transition ${
                item.status === 'error'
                  ? 'border-danger/30 bg-danger/5'
                  : 'border-transparent hover:border-line hover:bg-surface'
              }`}
            >
              <div className="flex items-start gap-2">
                <span className="mt-0.5 shrink-0 text-xs">{iconFor(item)}</span>

                <div className="min-w-0 flex-1">
                  <p className="truncate text-[11px] font-medium text-content" title={item.filename}>
                    {item.filename}
                  </p>
                  <p
                    className={`truncate text-[10px] ${item.status === 'error' ? 'text-danger' : 'text-faint'}`}
                    title={detailFor(item)}
                  >
                    {detailFor(item)}
                  </p>
                </div>

                <div className="flex shrink-0 gap-0.5 opacity-0 transition group-hover/item:opacity-100 focus-within:opacity-100">
                  {item.status === 'ready' && item.preview && (
                    <button
                      type="button"
                      onClick={() => onPreview(item)}
                      aria-label={`Preview ${item.filename}`}
                      className="rounded p-0.5 text-faint transition hover:bg-surface-strong hover:text-content"
                    >
                      <FiEye className="text-[11px]" />
                    </button>
                  )}
                  <button
                    type="button"
                    onClick={() => onRemove(item.key)}
                    aria-label={`Remove ${item.filename}`}
                    className="rounded p-0.5 text-faint transition hover:bg-surface-strong hover:text-danger"
                  >
                    <FiX className="text-[11px]" />
                  </button>
                </div>
              </div>
            </div>
          ))}
        </div>

        <button
          type="button"
          onClick={onAdd}
          className="mt-2 flex w-full items-center justify-center gap-1.5 rounded-lg border border-dashed border-line px-2 py-2 text-[11px] font-medium text-faint transition hover:border-accent/50 hover:text-content"
        >
          <FiPlus className="text-xs" /> Add files
        </button>

        {repo && (
          <div className="mt-4 border-t border-line pt-3">
            <p className="mb-2 text-[10px] font-semibold uppercase tracking-wider text-muted">Codebase</p>
            {repo}
          </div>
        )}
      </div>

      {ready.length > 0 && (
        <div className="border-t border-line px-3 py-2.5">
          <div className="flex items-baseline justify-between text-[10px]">
            <span className="text-faint">
              {ready.length} file{ready.length === 1 ? '' : 's'}
            </span>
            <span className={over ? 'font-semibold text-warm' : 'text-muted'}>
              ~{totalTokens.toLocaleString()} tok
            </span>
          </div>

          <div className="mt-1.5 h-1 overflow-hidden rounded-full bg-line">
            <div
              className={`h-full rounded-full transition-all ${over ? 'bg-warm' : 'bg-accent'}`}
              style={{ width: `${fill}%` }}
            />
          </div>

          {over && (
            <p className="mt-1.5 text-[10px] leading-snug text-warm">
              Over the {CONTEXT_BUDGET_TOKENS.toLocaleString()}-token window — only the passages
              matching your question will be sent.
            </p>
          )}
          {failed.length > 0 && (
            <p className="mt-1.5 text-[10px] text-danger">
              {failed.length} file{failed.length === 1 ? '' : 's'} failed to read
            </p>
          )}
        </div>
      )}
    </aside>
  );
}
