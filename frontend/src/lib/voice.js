/**
 * Browser Web Speech wrappers.
 *
 * STT uses SpeechRecognition (Chrome/Edge). Note this is NOT offline — Chrome
 * sends audio to Google for recognition. TTS uses speechSynthesis, which does
 * run locally. Local Whisper/Piper were rejected for now because this machine
 * has ~1GB free RAM against Ollama's 4.9GB, and adding them would swap.
 */

export const LANGUAGES = [
  { code: 'auto', label: 'Auto', speech: '' },
  { code: 'en-IN', label: 'English', speech: 'en-IN' },
  { code: 'hi-IN', label: 'हिन्दी', speech: 'hi-IN' },
  { code: 'mr-IN', label: 'मराठी', speech: 'mr-IN' },
  { code: 'ta-IN', label: 'தமிழ்', speech: 'ta-IN' },
  { code: 'te-IN', label: 'తెలుగు', speech: 'te-IN' },
  { code: 'bn-IN', label: 'বাংলা', speech: 'bn-IN' },
  { code: 'gu-IN', label: 'ગુજરાતી', speech: 'gu-IN' },
  { code: 'pa-IN', label: 'ਪੰਜਾਬੀ', speech: 'pa-IN' },
  { code: 'ur-PK', label: 'اردو', speech: 'ur-PK' }
];

export function getRecognitionCtor() {
  return typeof window === 'undefined' ? null : window.SpeechRecognition || window.webkitSpeechRecognition || null;
}

export const speechSupported = () => Boolean(getRecognitionCtor());
export const ttsSupported = () => typeof window !== 'undefined' && Boolean(window.speechSynthesis);

/**
 * Creates a recognition session.
 * `onFinal` fires with a completed utterance; `onInterim` streams the partial
 * text so the UI can show words as they are spoken.
 */
export function createRecognizer({ lang, continuous, onInterim, onFinal, onError, onEnd }) {
  const Ctor = getRecognitionCtor();
  if (!Ctor) return null;

  const recognition = new Ctor();
  // 'auto' means "let the browser decide" — an empty lang does that.
  recognition.lang = lang && lang !== 'auto' ? lang : '';
  recognition.continuous = Boolean(continuous);
  recognition.interimResults = true;
  recognition.maxAlternatives = 1;

  recognition.onresult = (event) => {
    let interim = '';
    for (let i = event.resultIndex; i < event.results.length; i += 1) {
      const result = event.results[i];
      const text = result[0]?.transcript || '';
      if (result.isFinal) {
        const trimmed = text.trim();
        if (trimmed) onFinal?.(trimmed, result[0]?.confidence);
      } else {
        interim += text;
      }
    }
    if (interim) onInterim?.(interim.trim());
  };

  recognition.onerror = (event) => {
    // 'aborted' and 'no-speech' are normal parts of a session, not failures.
    if (event.error === 'aborted' || event.error === 'no-speech') return;
    onError?.(event.error);
  };

  recognition.onend = () => onEnd?.();

  return recognition;
}

// Voices load asynchronously; the first getVoices() call is often empty.
export function loadVoices() {
  return new Promise((resolve) => {
    if (!ttsSupported()) return resolve([]);
    const existing = speechSynthesis.getVoices();
    if (existing.length) return resolve(existing);

    const timer = setTimeout(() => resolve(speechSynthesis.getVoices()), 1200);
    speechSynthesis.onvoiceschanged = () => {
      clearTimeout(timer);
      resolve(speechSynthesis.getVoices());
    };
  });
}

function pickVoice(voices, lang, preferredName) {
  if (!voices.length) return null;
  if (preferredName) {
    const exact = voices.find((v) => v.name === preferredName);
    if (exact) return exact;
  }
  if (!lang) return null;

  const base = lang.split('-')[0].toLowerCase();
  return (
    voices.find((v) => v.lang?.toLowerCase() === lang.toLowerCase()) ||
    voices.find((v) => v.lang?.toLowerCase().startsWith(base)) ||
    null
  );
}

/**
 * Splits text into speakable chunks. Long paragraphs are broken at sentence
 * boundaries so speech can begin before the whole answer exists, and because
 * some browsers silently truncate very long utterances.
 */
export function toSpeechChunks(text, maxChars = 220) {
  const clean = String(text || '')
    // Code blocks and markdown syntax are noise when read aloud.
    .replace(/```[\s\S]*?```/g, ' (code block) ')
    .replace(/`([^`]+)`/g, '$1')
    .replace(/\*\*([^*]+)\*\*/g, '$1')
    .replace(/[*_#>|]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  if (!clean) return [];

  const sentences = clean.match(/[^.!?]+[.!?]*/g) || [clean];
  const chunks = [];
  let current = '';

  for (const sentence of sentences) {
    if ((current + sentence).length > maxChars && current) {
      chunks.push(current.trim());
      current = '';
    }
    current += sentence;
  }
  if (current.trim()) chunks.push(current.trim());
  return chunks;
}

export function speak(text, { lang, voiceName, rate = 1, volume = 1, onStart, onEnd } = {}) {
  if (!ttsSupported()) return false;
  const chunks = toSpeechChunks(text);
  if (!chunks.length) return false;

  const voices = speechSynthesis.getVoices();
  const voice = pickVoice(voices, lang, voiceName);

  chunks.forEach((chunk, index) => {
    const utterance = new SpeechSynthesisUtterance(chunk);
    if (voice) utterance.voice = voice;
    if (lang) utterance.lang = lang;
    utterance.rate = rate;
    utterance.volume = volume;
    if (index === 0) utterance.onstart = () => onStart?.();
    if (index === chunks.length - 1) utterance.onend = () => onEnd?.();
    speechSynthesis.speak(utterance);
  });

  return true;
}

export function stopSpeaking() {
  if (ttsSupported()) speechSynthesis.cancel();
}

/**
 * Incremental speaker for streamed answers.
 *
 * Speaking only whole sentences matters: feeding partial text to
 * speechSynthesis produces stuttering and wrong intonation, because the engine
 * decides prosody per utterance. This tracks how much has already been spoken
 * and emits each newly-completed sentence as its own utterance.
 */
export function createStreamSpeaker({ lang, voiceName, rate = 1, onStart, onIdle } = {}) {
  let spokenUpTo = 0;
  let queued = 0;
  let started = false;

  const flushUtterance = (text) => {
    if (!text.trim()) return;
    const utterance = new SpeechSynthesisUtterance(text);
    const voice = pickVoice(speechSynthesis.getVoices(), lang, voiceName);
    if (voice) utterance.voice = voice;
    if (lang) utterance.lang = lang;
    utterance.rate = rate;

    queued += 1;
    if (!started) {
      started = true;
      utterance.onstart = () => onStart?.();
    }
    utterance.onend = () => {
      queued -= 1;
      if (queued <= 0) onIdle?.();
    };
    utterance.onerror = () => {
      queued -= 1;
      if (queued <= 0) onIdle?.();
    };
    speechSynthesis.speak(utterance);
  };

  return {
    /** Call with the full accumulated answer each time it grows. */
    push(fullText) {
      if (!ttsSupported()) return;
      const pending = String(fullText || '').slice(spokenUpTo);
      // Only take up to the last sentence terminator; the tail may still grow.
      const lastBreak = Math.max(pending.lastIndexOf('. '), pending.lastIndexOf('! '), pending.lastIndexOf('? '), pending.lastIndexOf('\n'));
      if (lastBreak === -1) return;

      const ready = pending.slice(0, lastBreak + 1);
      spokenUpTo += ready.length;
      for (const chunk of toSpeechChunks(ready)) flushUtterance(chunk);
    },

    /** Speak whatever is left once the answer is complete. */
    finish(fullText) {
      if (!ttsSupported()) return;
      const remaining = String(fullText || '').slice(spokenUpTo);
      spokenUpTo = String(fullText || '').length;
      for (const chunk of toSpeechChunks(remaining)) flushUtterance(chunk);
      if (queued === 0) onIdle?.();
    },

    cancel() {
      stopSpeaking();
      queued = 0;
    }
  };
}
