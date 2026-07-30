import React, { useState } from 'react';
import {
  FiMessageSquare, FiTrash2, FiEdit2, FiCheck, FiX, FiSearch, FiPlus, FiStar
} from 'react-icons/fi';

/**
 * The conversation sidebar.
 *
 * Every thread was previously lost the moment you started a new one — the
 * messages were in the database all along, the UI simply had no way back to
 * them. This is that way back.
 */

function whenLabel(iso) {
  const then = new Date(iso).getTime();
  if (!Number.isFinite(then)) return '';

  const mins = Math.round((Date.now() - then) / 60000);
  if (mins < 1) return 'now';
  if (mins < 60) return `${mins}m`;
  const hours = Math.round(mins / 60);
  if (hours < 24) return `${hours}h`;
  const days = Math.round(hours / 24);
  return days < 7 ? `${days}d` : new Date(then).toLocaleDateString(undefined, { day: 'numeric', month: 'short' });
}

/** Today / Yesterday / Last 7 days / Older — the shape people actually recall. */
function bucketOf(iso) {
  const then = new Date(iso);
  const now = new Date();
  const startOfToday = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
  const t = then.getTime();

  if (t >= startOfToday) return 'Today';
  if (t >= startOfToday - 86400000) return 'Yesterday';
  if (t >= startOfToday - 7 * 86400000) return 'Last 7 days';
  return 'Older';
}

const ORDER = ['Pinned', 'Today', 'Yesterday', 'Last 7 days', 'Older'];

export default function ConversationList({
  conversations, activeId, onSelect, onCreate, onRename, onDelete, onTogglePin, searchResults, onSearch
}) {
  const [query, setQuery] = useState('');
  const [editingId, setEditingId] = useState(null);
  const [draft, setDraft] = useState('');

  const searching = query.trim().length > 1;

  const groups = new Map();
  for (const c of conversations) {
    const bucket = c.pinned ? 'Pinned' : bucketOf(c.updatedAt);
    if (!groups.has(bucket)) groups.set(bucket, []);
    groups.get(bucket).push(c);
  }

  const startRename = (c) => {
    setEditingId(c.id);
    setDraft(c.title);
  };

  const commitRename = (id) => {
    const title = draft.trim();
    if (title) onRename(id, title);
    setEditingId(null);
  };

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <button
        type="button"
        onClick={onCreate}
        className="mb-3 flex w-full items-center gap-2 rounded-xl bg-gradient-to-r from-accent to-accent-strong px-3 py-2.5 text-xs font-semibold text-accent-contrast shadow-soft transition hover:opacity-90"
      >
        <FiPlus /> New conversation
      </button>

      <label className="mb-2 flex items-center gap-2 rounded-lg border border-line bg-surface/60 px-2.5 py-1.5 focus-within:border-accent/50">
        <FiSearch className="shrink-0 text-xs text-faint" />
        <span className="sr-only">Search conversations</span>
        <input
          value={query}
          onChange={(e) => { setQuery(e.target.value); onSearch(e.target.value); }}
          placeholder="Search"
          className="min-w-0 flex-1 bg-transparent text-[11px] text-content placeholder:text-faint focus:outline-none"
        />
        {query && (
          <button type="button" onClick={() => { setQuery(''); onSearch(''); }} aria-label="Clear search">
            <FiX className="text-xs text-faint hover:text-content" />
          </button>
        )}
      </label>

      <div className="min-h-0 flex-1 overflow-y-auto pr-0.5">
        {searching ? (
          <div className="space-y-0.5">
            <p className="px-1 pb-1 text-[10px] font-semibold uppercase tracking-wider text-faint">
              {searchResults.length} match{searchResults.length === 1 ? '' : 'es'}
            </p>
            {searchResults.map((r, i) => (
              <button
                key={`${r.conversationId}-${i}`}
                type="button"
                onClick={() => onSelect(r.conversationId)}
                className="w-full rounded-lg px-2 py-1.5 text-left transition hover:bg-surface"
              >
                <p className="truncate text-[11px] font-medium text-content">{r.title}</p>
                <p className="truncate text-[10px] text-faint">{r.snippet}</p>
              </button>
            ))}
            {!searchResults.length && (
              <p className="px-1 py-3 text-[11px] text-faint">Nothing found.</p>
            )}
          </div>
        ) : (
          ORDER.filter((b) => groups.has(b)).map((bucket) => (
            <div key={bucket} className="mb-2">
              <p className="px-1 pb-1 text-[10px] font-semibold uppercase tracking-wider text-faint">
                {bucket}
              </p>

              <div className="space-y-0.5">
                {groups.get(bucket).map((c) => {
                  const active = c.id === activeId;

                  if (editingId === c.id) {
                    return (
                      <div key={c.id} className="flex items-center gap-1 rounded-lg bg-surface px-2 py-1.5">
                        <input
                          autoFocus
                          value={draft}
                          onChange={(e) => setDraft(e.target.value)}
                          onKeyDown={(e) => {
                            if (e.key === 'Enter') commitRename(c.id);
                            if (e.key === 'Escape') setEditingId(null);
                          }}
                          className="min-w-0 flex-1 bg-transparent text-[11px] text-content focus:outline-none"
                        />
                        <button type="button" onClick={() => commitRename(c.id)} aria-label="Save">
                          <FiCheck className="text-xs text-success" />
                        </button>
                        <button type="button" onClick={() => setEditingId(null)} aria-label="Cancel">
                          <FiX className="text-xs text-faint" />
                        </button>
                      </div>
                    );
                  }

                  return (
                    <div
                      key={c.id}
                      className={`group/row flex items-center gap-1.5 rounded-lg px-2 py-1.5 transition ${
                        active ? 'bg-surface text-content' : 'text-muted hover:bg-surface/60'
                      }`}
                    >
                      <button
                        type="button"
                        onClick={() => onSelect(c.id)}
                        className="flex min-w-0 flex-1 items-center gap-2 text-left"
                        title={c.title}
                      >
                        <FiMessageSquare className={`shrink-0 text-xs ${active ? 'text-accent' : 'text-faint'}`} />
                        <span className="min-w-0 flex-1">
                          <span className="block truncate text-[11px] font-medium">{c.title}</span>
                          <span className="block truncate text-[10px] text-faint">
                            {c.messageCount} message{c.messageCount === 1 ? '' : 's'} · {whenLabel(c.updatedAt)}
                          </span>
                        </span>
                      </button>

                      <div className="flex shrink-0 gap-0.5 opacity-0 transition group-hover/row:opacity-100 focus-within:opacity-100">
                        <button
                          type="button"
                          onClick={() => onTogglePin(c.id, !c.pinned)}
                          aria-label={c.pinned ? 'Unpin' : 'Pin'}
                          className={`rounded p-0.5 transition hover:bg-surface-strong ${c.pinned ? 'text-warm' : 'text-faint hover:text-content'}`}
                        >
                          <FiStar className="text-[11px]" />
                        </button>
                        <button
                          type="button"
                          onClick={() => startRename(c)}
                          aria-label="Rename"
                          className="rounded p-0.5 text-faint transition hover:bg-surface-strong hover:text-content"
                        >
                          <FiEdit2 className="text-[11px]" />
                        </button>
                        <button
                          type="button"
                          onClick={() => onDelete(c.id, c.title)}
                          aria-label="Delete"
                          className="rounded p-0.5 text-faint transition hover:bg-surface-strong hover:text-danger"
                        >
                          <FiTrash2 className="text-[11px]" />
                        </button>
                      </div>
                    </div>
                  );
                })}
              </div>
            </div>
          ))
        )}

        {!searching && !conversations.length && (
          <p className="px-1 py-3 text-[11px] leading-relaxed text-faint">
            No conversations yet. Ask something and it will appear here.
          </p>
        )}
      </div>
    </div>
  );
}
