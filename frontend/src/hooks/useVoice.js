import { useCallback, useEffect, useRef, useState } from 'react';
import {
  createRecognizer, speechSupported, ttsSupported, speak, stopSpeaking, loadVoices, createStreamSpeaker
} from '../lib/voice';

/**
 * Voice session state machine:
 *   idle → listening → transcribing → (caller runs retrieval) → speaking → idle
 *
 * The hook only handles microphone and speaker. It deliberately knows nothing
 * about retrieval — the transcript is handed to the existing chat pipeline so
 * voice and text share one engine, with no duplicated logic.
 */
export default function useVoice({ language = 'en-IN', autoSpeak = true, rate = 1, onUtterance } = {}) {
  const [state, setState] = useState('idle');
  const [interim, setInterim] = useState('');
  const [error, setError] = useState(null);
  const [voices, setVoices] = useState([]);

  const recognizerRef = useRef(null);
  const streamerRef = useRef(null);
  // Kept in refs so the recognition callbacks always see current values
  // without needing to be torn down and rebuilt on every render.
  const onUtteranceRef = useRef(onUtterance);
  const languageRef = useRef(language);

  useEffect(() => { onUtteranceRef.current = onUtterance; }, [onUtterance]);
  useEffect(() => { languageRef.current = language; }, [language]);

  useEffect(() => {
    let alive = true;
    loadVoices().then((v) => { if (alive) setVoices(v); });
    return () => { alive = false; };
  }, []);

  const stopListening = useCallback(() => {
    try {
      recognizerRef.current?.stop();
    } catch {
      // already stopped
    }
    recognizerRef.current = null;
    setInterim('');
    setState((s) => (s === 'speaking' ? s : 'idle'));
  }, []);

  const startListening = useCallback(() => {
    if (!speechSupported()) {
      setError('Speech recognition is not available in this browser. Chrome or Edge is required.');
      return false;
    }

    // Barge-in: the user talking over the assistant cancels playback
    // immediately, and stops the mic transcribing our own voice.
    streamerRef.current?.cancel();
    stopSpeaking();
    setError(null);
    setInterim('');

    const recognition = createRecognizer({
      lang: languageRef.current,
      continuous: false,
      onInterim: (text) => {
        setInterim(text);
        setState('listening');
      },
      onFinal: (text) => {
        setInterim('');
        setState('transcribing');
        onUtteranceRef.current?.(text);
      },
      onError: (err) => {
        setError(
          err === 'not-allowed'
            ? 'Microphone permission was denied. Allow mic access and try again.'
            : `Speech recognition error: ${err}`
        );
        setState('idle');
      },
      onEnd: () => {
        recognizerRef.current = null;
        // Only fall back to idle if we are not already generating or speaking.
        setState((s) => (s === 'listening' ? 'idle' : s));
      }
    });

    if (!recognition) return false;
    recognizerRef.current = recognition;

    try {
      recognition.start();
      setState('listening');
      return true;
    } catch {
      // start() throws if a session is already running.
      setState('idle');
      return false;
    }
  }, []);

  const say = useCallback(
    (text, { voiceName } = {}) => {
      if (!autoSpeak || !ttsSupported()) return;
      speak(text, {
        lang: languageRef.current === 'auto' ? undefined : languageRef.current,
        voiceName,
        rate,
        onStart: () => setState('speaking'),
        onEnd: () => setState('idle')
      });
    },
    [autoSpeak, rate]
  );

  // --- streaming speech -----------------------------------------------------
  // Begins speaking the first sentence while the rest is still generating,
  // instead of waiting ~35s for the whole answer.
  const beginStream = useCallback(() => {
    if (!autoSpeak || !ttsSupported()) return;
    streamerRef.current?.cancel();
    streamerRef.current = createStreamSpeaker({
      lang: languageRef.current === 'auto' ? undefined : languageRef.current,
      rate,
      onStart: () => setState('speaking'),
      onIdle: () => setState((s) => (s === 'speaking' ? 'idle' : s))
    });
  }, [autoSpeak, rate]);

  const pushStream = useCallback((fullText) => streamerRef.current?.push(fullText), []);

  const endStream = useCallback((fullText) => {
    streamerRef.current?.finish(fullText);
    streamerRef.current = null;
  }, []);

  const shutUp = useCallback(() => {
    streamerRef.current?.cancel();
    stopSpeaking();
    setState('idle');
  }, []);

  // Never leave the mic hot or the speaker talking after unmount.
  useEffect(
    () => () => {
      try {
        recognizerRef.current?.abort?.();
      } catch {
        /* noop */
      }
      streamerRef.current?.cancel();
      stopSpeaking();
    },
    []
  );

  return {
    state,
    interim,
    error,
    voices,
    supported: speechSupported(),
    ttsAvailable: ttsSupported(),
    startListening,
    stopListening,
    say,
    beginStream,
    pushStream,
    endStream,
    shutUp,
    setState
  };
}
