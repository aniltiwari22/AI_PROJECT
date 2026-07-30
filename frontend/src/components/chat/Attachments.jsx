import React from 'react';
import { FiFileText, FiImage, FiFile, FiX, FiLoader, FiAlertTriangle, FiCheck } from 'react-icons/fi';

function iconFor(attachment) {
  if (attachment.status === 'uploading') return <FiLoader className="animate-spin text-accent" />;
  if (attachment.status === 'error') return <FiAlertTriangle className="text-danger" />;
  if (attachment.kind === 'image') return <FiImage className="text-accent" />;
  if (attachment.kind === 'pdf' || attachment.kind === 'office') return <FiFileText className="text-success" />;
  return <FiFile className="text-muted" />;
}

function subtitleFor(attachment) {
  if (attachment.status === 'uploading') {
    return attachment.kind === 'image' ? 'reading image…' : 'extracting text…';
  }
  if (attachment.status === 'error') return attachment.error;
  if (attachment.warning) return attachment.warning;

  // Show what was actually extracted, so a silent bad read is visible rather
  // than looking identical to a good one.
  const bits = [];
  if (attachment.pages) bits.push(`${attachment.pages}p`);
  if (attachment.chars) bits.push(`${attachment.chars.toLocaleString()} chars read`);
  if (attachment.elapsedMs) bits.push(`${(attachment.elapsedMs / 1000).toFixed(1)}s`);
  if (attachment.optimised) bits.push(`${attachment.optimised.pixelReduction}× smaller`);
  if (attachment.truncated) bits.push('truncated');
  return bits.join(' · ') || 'ready';
}

export default function Attachments({ attachments, onRemove }) {
  if (!attachments.length) return null;

  return (
    <div className="mb-2 flex flex-wrap gap-2">
      {attachments.map((attachment) => {
        const failed = attachment.status === 'error';
        const warned = Boolean(attachment.warning) && !failed;

        return (
          <div
            key={attachment.key}
            className={`animate-fade-in flex max-w-xs items-start gap-2 rounded-lg border px-2.5 py-1.5 text-xs ${
              failed
                ? 'border-danger/30 bg-danger/5'
                : warned
                  ? 'border-warm/30 bg-warm/5'
                  : 'border-line bg-surface/70'
            }`}
          >
            <span className="mt-0.5 shrink-0">{iconFor(attachment)}</span>

            <span className="min-w-0 flex-1">
              <span className="flex items-center gap-1">
                <span className="truncate font-medium text-content">{attachment.filename}</span>
                {attachment.status === 'ready' && !warned && <FiCheck className="shrink-0 text-success" />}
              </span>
              <span
                className={`block truncate text-[10px] ${
                  failed ? 'text-danger' : warned ? 'text-warm' : 'text-faint'
                }`}
                title={subtitleFor(attachment)}
              >
                {subtitleFor(attachment)}
              </span>
            </span>

            <button
              type="button"
              onClick={() => onRemove(attachment.key)}
              aria-label={`Remove ${attachment.filename}`}
              className="mt-0.5 shrink-0 rounded p-0.5 text-faint transition hover:bg-surface-strong hover:text-content"
            >
              <FiX />
            </button>
          </div>
        );
      })}
    </div>
  );
}
