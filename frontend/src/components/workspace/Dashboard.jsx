import React from 'react';
import {
  FiCode, FiAlertCircle, FiFileText, FiGrid, FiGlobe, FiMic,
  FiBookOpen, FiZap, FiClock, FiFile, FiImage
} from 'react-icons/fi';

function greeting() {
  const hour = new Date().getHours();
  if (hour < 12) return 'Good morning';
  if (hour < 17) return 'Good afternoon';
  return 'Good evening';
}

// Every action is a prompt this assistant can actually answer. Cards that open
// features which do not exist are worse than no cards at all.
const ACTIONS = [
  { icon: FiCode, title: 'Generate code', sub: 'Write a function', accent: 'text-accent',
    prompt: 'Write a debounce function in JavaScript with an example of how to use it.' },
  { icon: FiAlertCircle, title: 'Debug', sub: 'Find what broke', accent: 'text-danger',
    prompt: 'My Express route returns 404. Walk me through what to check, in order.' },
  { icon: FiBookOpen, title: 'Explain code', sub: 'Understand a file', accent: 'text-accent-strong',
    prompt: 'Attach a source file and I will explain what it does, function by function.' },
  { icon: FiFileText, title: 'Summarise a PDF', sub: 'Attach and ask', accent: 'text-warm',
    prompt: 'Summarise the attached document in bullet points, keeping every number exact.' },
  { icon: FiGrid, title: 'Analyse a sheet', sub: 'Excel or CSV', accent: 'text-success',
    prompt: 'Attach a spreadsheet and tell me what stands out in the data.' },
  { icon: FiGlobe, title: 'Search the web', sub: 'Current information', accent: 'text-accent-strong',
    prompt: 'What is the latest stable Node.js LTS version and when does it reach end of life?' },
  { icon: FiZap, title: 'Review for bugs', sub: 'Second pair of eyes', accent: 'text-warm',
    prompt: 'What are the most common mistakes in async JavaScript error handling?' },
  { icon: FiMic, title: 'Talk to it', sub: 'Voice conversation', accent: 'text-success',
    prompt: 'How do I get the best results from you when I am asking questions out loud?' }
];

function iconForFile(file) {
  if (file.kind === 'image') return FiImage;
  if (file.kind === 'pdf' || file.kind === 'office') return FiFileText;
  return FiFile;
}

function relativeTime(iso) {
  const then = new Date(iso).getTime();
  if (!Number.isFinite(then)) return '';
  const mins = Math.round((Date.now() - then) / 60000);
  if (mins < 1) return 'just now';
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.round(mins / 60);
  if (hours < 24) return `${hours}h ago`;
  return `${Math.round(hours / 24)}d ago`;
}

export default function Dashboard({ onPick, recentFiles = [], stats }) {
  return (
    <div className="mx-auto w-full max-w-4xl px-5 py-10">
      <div className="animate-fade-in">
        <h1 className="text-balance text-3xl font-semibold tracking-tight text-content">
          {greeting()}
          <span className="ml-2">👋</span>
        </h1>
        <p className="mt-2 text-sm text-muted">What can I help you with?</p>
      </div>

      <div className="animate-fade-up mt-8 grid grid-cols-2 gap-2.5 sm:grid-cols-3 lg:grid-cols-4">
        {ACTIONS.map(({ icon: Icon, title, sub, accent, prompt }) => (
          <button
            key={title}
            type="button"
            onClick={() => onPick(prompt)}
            title={prompt}
            className="glass group flex flex-col items-start gap-2 rounded-2xl border border-line p-3.5 text-left shadow-soft transition hover:-translate-y-0.5 hover:border-accent/40 hover:shadow-lift"
          >
            <Icon className={`text-base ${accent} transition group-hover:scale-110`} />
            <span className="min-w-0">
              <span className="block truncate text-xs font-semibold text-content">{title}</span>
              <span className="block truncate text-[11px] text-faint">{sub}</span>
            </span>
          </button>
        ))}
      </div>

      {recentFiles.length > 0 && (
        <div className="animate-fade-up mt-8">
          <h2 className="mb-2.5 flex items-center gap-1.5 text-[11px] font-semibold uppercase tracking-wider text-muted">
            <FiClock className="text-xs" /> Recent files
          </h2>
          <div className="grid gap-1.5 sm:grid-cols-2">
            {recentFiles.map((file) => {
              const Icon = iconForFile(file);
              return (
                <button
                  key={file.id}
                  type="button"
                  onClick={() => onPick(`About ${file.filename}: `)}
                  className="flex items-center gap-2.5 rounded-xl border border-line bg-surface/40 px-3 py-2 text-left transition hover:border-accent/40 hover:bg-surface"
                >
                  <Icon className="shrink-0 text-sm text-faint" />
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-xs font-medium text-content">{file.filename}</span>
                    <span className="block truncate text-[10px] text-faint">
                      {file.chars ? `${file.chars.toLocaleString()} chars` : file.kind}
                      {file.createdAt ? ` · ${relativeTime(file.createdAt)}` : ''}
                    </span>
                  </span>
                </button>
              );
            })}
          </div>
        </div>
      )}

      {stats && (
        <div className="animate-fade-up mt-8 flex flex-wrap gap-2">
          {stats.map((s) => (
            <span
              key={s.label}
              className="rounded-xl border border-line bg-surface/40 px-3 py-1.5 text-[11px]"
              title={s.title}
            >
              <span className="text-faint">{s.label} </span>
              <span className="font-mono font-medium text-content">{s.value}</span>
            </span>
          ))}
        </div>
      )}
    </div>
  );
}
