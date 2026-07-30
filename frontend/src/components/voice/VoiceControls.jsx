import React from 'react';
import { FiMic, FiMicOff, FiVolume2, FiVolumeX, FiAlertTriangle } from 'react-icons/fi';
import { LANGUAGES } from '../../lib/voice';

const STATE_LABEL = {
  listening: 'Listening',
  transcribing: 'Transcribing',
  speaking: 'Speaking',
  idle: ''
};

/** Animated bars while the mic is open — cheap, and makes "listening" obvious. */
function Wave({ active }) {
  return (
    <span className="flex items-end gap-0.5" aria-hidden="true">
      {[0, 1, 2, 3].map((i) => (
        <span
          key={i}
          className={`w-0.5 rounded-full bg-danger transition-all ${active ? 'animate-bounce-dot' : ''}`}
          style={{ height: active ? `${5 + (i % 3) * 4}px` : '4px', animationDelay: `${i * 0.12}s` }}
        />
      ))}
    </span>
  );
}

export default function VoiceControls({
  voice,
  language,
  onLanguageChange,
  autoSpeak,
  onToggleAutoSpeak
}) {
  if (!voice.supported) {
    return (
      <span
        title="Speech recognition needs Chrome or Edge"
        className="flex h-9 w-9 items-center justify-center rounded-xl text-faint"
      >
        <FiMicOff className="text-sm" />
      </span>
    );
  }

  const listening = voice.state === 'listening';
  const busy = voice.state === 'transcribing';

  return (
    <>
      <button
        type="button"
        onClick={listening ? voice.stopListening : voice.startListening}
        disabled={busy}
        aria-label={listening ? 'Stop listening' : 'Speak your question'}
        title={listening ? 'Stop listening' : 'Speak your question'}
        className={`flex h-9 w-9 shrink-0 items-center justify-center rounded-xl transition ${
          listening
            ? 'bg-danger/15 text-danger'
            : busy
              ? 'cursor-wait text-faint'
              : 'text-faint hover:bg-surface hover:text-accent'
        }`}
      >
        {listening ? <Wave active /> : <FiMic className="text-sm" />}
      </button>

      {/* Speaker toggle only matters when TTS actually exists. */}
      {voice.ttsAvailable && (
        <button
          type="button"
          onClick={() => {
            if (voice.state === 'speaking') voice.shutUp();
            onToggleAutoSpeak();
          }}
          aria-label={autoSpeak ? 'Mute spoken replies' : 'Speak replies aloud'}
          title={autoSpeak ? 'Replies are spoken aloud' : 'Replies are silent'}
          className={`hidden h-9 w-9 shrink-0 items-center justify-center rounded-xl transition sm:flex ${
            autoSpeak ? 'text-accent hover:bg-surface' : 'text-faint hover:bg-surface hover:text-content'
          }`}
        >
          {autoSpeak ? <FiVolume2 className="text-sm" /> : <FiVolumeX className="text-sm" />}
        </button>
      )}

      <select
        value={language}
        onChange={(e) => onLanguageChange(e.target.value)}
        aria-label="Speech language"
        title="Speech language"
        className="hidden h-9 shrink-0 rounded-xl border border-line bg-transparent px-1.5 text-[11px] text-muted focus:outline-none md:block"
      >
        {LANGUAGES.map((l) => (
          <option key={l.code} value={l.code} className="bg-elevated text-content">
            {l.label}
          </option>
        ))}
      </select>
    </>
  );
}

/** Live transcript / status strip shown above the composer. */
export function VoiceStatus({ voice }) {
  if (voice.error) {
    return (
      <div className="mb-2 flex items-start gap-2 rounded-xl border border-danger/30 bg-danger/5 px-3 py-2 text-xs text-danger">
        <FiAlertTriangle className="mt-0.5 shrink-0" />
        <span>{voice.error}</span>
      </div>
    );
  }

  const label = STATE_LABEL[voice.state];
  if (!label && !voice.interim) return null;

  return (
    <div className="animate-fade-in mb-2 flex items-center gap-2 rounded-xl border border-line bg-surface/60 px-3 py-2 text-xs">
      <span className="flex items-center gap-1.5 font-medium text-accent">
        {voice.state === 'listening' && <Wave active />}
        {label}
      </span>
      {voice.interim && <span className="min-w-0 flex-1 truncate italic text-muted">“{voice.interim}”</span>}
    </div>
  );
}
