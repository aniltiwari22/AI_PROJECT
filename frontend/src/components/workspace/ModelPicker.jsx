import React from 'react';
import { FiCpu } from 'react-icons/fi';

// Shortens "qwen2.5-coder:7b" to "qwen2.5-coder" for the closed control; the
// full name with size stays in the dropdown and the tooltip.
function shortName(name) {
  return String(name).split(':')[0];
}

/**
 * Model selection lives in the composer because on CPU it is the single
 * biggest lever on how long an answer takes — measured here at 15.8 tok/s
 * prompt-eval for a 7B against 64.8 tok/s for a 1.3B on the same input.
 * Burying that in a settings page hides the one choice that matters.
 */
export default function ModelPicker({ models, value, onChange, disabled }) {
  if (!models.length) return null;

  const current = models.find((m) => m.name === value) || models[0];

  return (
    <label
      className="flex items-center gap-1.5 rounded-lg border border-line bg-surface/60 px-2 py-1 text-[11px] text-muted transition focus-within:border-accent/50 hover:border-line-strong"
      title={`Answering with ${current.name}${current.sizeGb ? ` (${current.sizeGb}GB)` : ''}`}
    >
      <FiCpu className="shrink-0 text-xs text-faint" />
      <span className="sr-only">Model</span>
      <select
        value={value}
        onChange={(e) => onChange(e.target.value)}
        disabled={disabled}
        className="cursor-pointer appearance-none bg-transparent pr-1 font-medium text-content outline-none disabled:cursor-not-allowed disabled:opacity-50"
      >
        {models.map((m) => (
          <option key={m.name} value={m.name}>
            {shortName(m.name)}
            {m.sizeGb ? ` · ${m.sizeGb}GB` : ''}
            {m.isDefault ? ' (default)' : ''}
          </option>
        ))}
      </select>
    </label>
  );
}
