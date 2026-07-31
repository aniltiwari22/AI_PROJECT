import React, { useState } from 'react';
import { FiUser, FiCopy, FiCheck, FiAlertTriangle, FiRefreshCw, FiPaperclip, FiSquare } from 'react-icons/fi';
import CodeBlock from './CodeBlock';
import DiffBlock from './DiffBlock';
import SourceList from './SourceList';
import MessageCost from './MessageCost';
import SaveAnswer from './SaveAnswer';
import DevTools from '../workspace/DevTools';
import { splitFencedBlocks } from '../../lib/markdown';

// Minimal markdown support built in-house: the project has no markdown
// dependency, and fenced code blocks are the one thing a coding assistant
// genuinely cannot read without. Everything is built as React elements
// (never dangerouslySetInnerHTML) so model output can't inject markup.

function renderInline(text, keyPrefix) {
  const nodes = [];
  // Bold before italic, so **x** is not consumed as two italic markers.
  // Italic requires word boundaries so snake_case_names stay intact.
  const pattern = /(`[^`\n]+`|\*\*[^*\n]+\*\*|(?<![\w*])[*_][^*_\n]+[*_](?![\w*]))/g;
  let lastIndex = 0;
  let match;
  let i = 0;

  while ((match = pattern.exec(text)) !== null) {
    if (match.index > lastIndex) nodes.push(text.slice(lastIndex, match.index));
    const token = match[0];

    if (token.startsWith('`')) {
      nodes.push(
        <code
          key={`${keyPrefix}-code-${i}`}
          className="rounded-md bg-accent/12 px-1.5 py-0.5 font-mono text-[0.85em] text-accent ring-1 ring-inset ring-accent/20"
        >
          {token.slice(1, -1)}
        </code>
      );
    } else if (token.startsWith('**')) {
      nodes.push(
        <strong key={`${keyPrefix}-bold-${i}`} className="font-semibold text-content">
          {token.slice(2, -2)}
        </strong>
      );
    } else {
      nodes.push(
        <em key={`${keyPrefix}-em-${i}`} className="italic text-muted">
          {token.slice(1, -1)}
        </em>
      );
    }

    lastIndex = match.index + token.length;
    i += 1;
  }

  if (lastIndex < text.length) nodes.push(text.slice(lastIndex));
  return nodes;
}

function useCopy() {
  const [copied, setCopied] = useState(false);

  const copy = async (value) => {
    try {
      await navigator.clipboard.writeText(value);
      setCopied(true);
      setTimeout(() => setCopied(false), 1600);
    } catch {
      // clipboard blocked (insecure origin / denied) — leave the icon as-is
    }
  };

  return [copied, copy];
}

function TextBlock({ content, keyPrefix }) {
  // Blank line = paragraph break; single newlines stay inside a paragraph.
  const paragraphs = content.split(/\n{2,}/).filter((p) => p.trim());

  return paragraphs.map((paragraph, pIndex) => {
    const lines = paragraph.split('\n');
    const isList = lines.every((line) => /^\s*([-*]|\d+\.)\s+/.test(line));

    if (isList) {
      const ordered = /^\s*\d+\./.test(lines[0]);
      const ListTag = ordered ? 'ol' : 'ul';

      return (
        <ListTag
          key={`${keyPrefix}-list-${pIndex}`}
          className={`my-3 space-y-1.5 pl-5 first:mt-0 last:mb-0 ${ordered ? 'list-decimal' : 'list-disc'} marker:text-accent/60`}
        >
          {lines.map((line, lIndex) => (
            <li key={lIndex} className="pl-1">
              {renderInline(line.replace(/^\s*([-*]|\d+\.)\s+/, ''), `${keyPrefix}-${pIndex}-${lIndex}`)}
            </li>
          ))}
        </ListTag>
      );
    }

    return (
      <p key={`${keyPrefix}-p-${pIndex}`} className="my-3 whitespace-pre-wrap first:mt-0 last:mb-0">
        {renderInline(paragraph, `${keyPrefix}-${pIndex}`)}
      </p>
    );
  });
}

function MessageContent({ text }) {
  const blocks = splitFencedBlocks(text);

  return blocks.map((block, index) =>
    block.type === 'code' ? (
      // A diff is read differently from code: per-line +/- colouring instead of
      // syntax highlighting, since what matters is what changed.
      /^(diff|patch|udiff)$/i.test(block.lang || '')
        ? <DiffBlock key={`diff-${index}`} content={block.content} />
        : <CodeBlock key={`code-${index}`} lang={block.lang} content={block.content} />
    ) : (
      <TextBlock key={`text-${index}`} content={block.content} keyPrefix={`b${index}`} />
    )
  );
}

function AssistantMark() {
  return (
    <span className="relative flex h-7 w-7 shrink-0 items-center justify-center">
      <span className="absolute inset-0 rounded-lg bg-gradient-to-br from-accent to-warm opacity-90" />
      <span className="relative font-mono text-[11px] font-bold text-accent-contrast">A</span>
    </span>
  );
}

export default function ChatComponent1({ message, onRegenerate, canRegenerate, askedQuestion }) {
  const isUser = message.role === 'user';
  const isSystem = message.role === 'system';
  const isError = message.role === 'error';
  const [copied, copy] = useCopy();

  if (isSystem) {
    return (
      <div className="animate-fade-in mx-auto flex max-w-3xl items-center gap-3 py-1">
        <span className="h-px flex-1 bg-gradient-to-r from-transparent to-line" />
        <span className="font-mono text-[10px] uppercase tracking-[0.18em] text-faint">{message.text}</span>
        <span className="h-px flex-1 bg-gradient-to-l from-transparent to-line" />
      </div>
    );
  }

  // User turns stay as a compact right-aligned bubble; assistant turns run the
  // full column width so long answers, tables and code have room to breathe.
  if (isUser) {
    return (
      <div className="animate-fade-up mx-auto flex w-full max-w-3xl justify-end gap-3">
        <div className="flex max-w-[85%] flex-col items-end gap-1.5">
          {message.files?.length > 0 && (
            <div className="flex flex-wrap justify-end gap-1.5">
              {message.files.map((name) => (
                <span
                  key={name}
                  className="inline-flex max-w-[14rem] items-center gap-1.5 rounded-lg border border-line bg-surface/70 px-2 py-1 text-[11px] text-muted"
                >
                  <FiPaperclip className="shrink-0 text-[10px] text-accent" />
                  <span className="truncate">{name}</span>
                </span>
              ))}
            </div>
          )}
          <div className="rounded-2xl rounded-br-md bg-accent px-4 py-2.5 text-[15px] leading-relaxed text-accent-contrast shadow-soft">
            <span className="whitespace-pre-wrap break-words">{message.text}</span>
          </div>
        </div>
        <span className="mt-0.5 flex h-7 w-7 shrink-0 items-center justify-center rounded-lg border border-line bg-surface text-muted">
          <FiUser className="text-xs" />
        </span>
      </div>
    );
  }

  return (
    <div className="animate-fade-up group mx-auto w-full max-w-3xl">
      <div className="flex gap-3">
        {isError ? (
          <span className="flex h-7 w-7 shrink-0 items-center justify-center rounded-lg bg-danger/15 text-danger">
            <FiAlertTriangle className="text-xs" />
          </span>
        ) : (
          <AssistantMark />
        )}

        <div className="min-w-0 flex-1">
          <div
            className={`text-[15px] leading-[1.7] ${
              isError ? 'rounded-xl border border-danger/25 bg-danger/5 px-3 py-2 text-danger' : 'text-content'
            }`}
          >
            {isError ? (
              <span className="whitespace-pre-wrap break-words">{message.text}</span>
            ) : (
              <MessageContent text={message.text} />
            )}
          </div>

          <div className="mt-2 flex flex-wrap items-center gap-2">
            {message.stopped && (
              // A stopped reply is incomplete — say so, or it reads as complete.
              <span className="inline-flex items-center gap-1.5 rounded-lg border border-warm/30 bg-warm/10 px-2 py-0.5 text-[11px] font-medium text-warm">
                <FiSquare className="text-[9px]" fill="currentColor" />
                Stopped — incomplete
              </span>
            )}

            {!isError && !message.stopped && message.text && (
              <SourceList origin={message.origin} sources={message.sources} confidence={message.confidence} />
            )}

            {!isError && message.text && (
              <MessageCost telemetry={message.telemetry} totalMs={message.totalMs} />
            )}

            {message.text && (
              <div className="flex items-center gap-1 opacity-0 transition focus-within:opacity-100 group-hover:opacity-100">
                <button
                  type="button"
                  onClick={() => copy(message.text)}
                  aria-label="Copy message"
                  className="flex items-center gap-1 rounded-lg px-1.5 py-1 text-[11px] text-faint transition hover:bg-surface hover:text-content"
                >
                  {copied ? <FiCheck className="text-success" /> : <FiCopy />}
                  {copied ? 'Copied' : 'Copy'}
                </button>

                {canRegenerate && (
                  <button
                    type="button"
                    onClick={onRegenerate}
                    aria-label="Regenerate response"
                    className="flex items-center gap-1 rounded-lg px-1.5 py-1 text-[11px] text-faint transition hover:bg-surface hover:text-accent"
                  >
                    <FiRefreshCw /> Retry
                  </button>
                )}
              </div>
            )}
          </div>

          {!isError && <DevTools message={message} />}
        </div>
      </div>
    </div>
  );
}
