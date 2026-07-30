import React, { useState, useRef, useEffect } from 'react';
import { FiLock, FiLoader, FiAlertCircle } from 'react-icons/fi';

/**
 * Password gate.
 *
 * Every API route now requires a session, so without this the app would load
 * to an empty shell and a wall of 401s.
 */
export default function LoginScreen({ onAuthenticated, login }) {
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const inputRef = useRef(null);

  useEffect(() => { inputRef.current?.focus(); }, []);

  const submit = async (event) => {
    event.preventDefault();
    if (!password || busy) return;

    setBusy(true);
    setError('');

    const result = await login(password);
    setBusy(false);

    if (result.ok) {
      setPassword('');
      onAuthenticated();
    } else {
      setError(result.error || 'Could not sign in');
      setPassword('');
      inputRef.current?.focus();
    }
  };

  return (
    <div className="aurora flex h-screen items-center justify-center bg-bg px-5 font-sans text-content">
      <div className="animate-fade-up w-full max-w-xs">
        <div className="mb-7 flex flex-col items-center text-center">
          <span className="relative mb-4 flex h-14 w-14 items-center justify-center">
            <span className="absolute inset-0 animate-breathe rounded-2xl bg-gradient-to-br from-accent to-warm opacity-60 blur-xl" />
            <span className="relative flex h-14 w-14 items-center justify-center rounded-2xl bg-gradient-to-br from-accent to-warm shadow-lift">
              <span className="font-mono text-lg font-bold text-accent-contrast">A</span>
            </span>
          </span>
          <h1 className="text-lg font-semibold tracking-tight">Ashu Codex AI</h1>
          <p className="mt-1 text-xs text-muted">Enter your password to continue</p>
        </div>

        <form onSubmit={submit} className="glass rounded-2xl border border-line p-4 shadow-lift">
          <label className="block">
            <span className="sr-only">Password</span>
            <div className="flex items-center gap-2 rounded-xl border border-line bg-surface/60 px-3 py-2.5 transition focus-within:border-accent/50 focus-within:ring-4 focus-within:ring-accent/10">
              <FiLock className="shrink-0 text-sm text-faint" />
              <input
                ref={inputRef}
                type="password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                autoComplete="current-password"
                placeholder="Password"
                className="min-w-0 flex-1 bg-transparent text-sm text-content placeholder:text-faint focus:outline-none"
              />
            </div>
          </label>

          {error && (
            <p className="mt-2.5 flex items-start gap-1.5 text-[11px] leading-snug text-danger">
              <FiAlertCircle className="mt-0.5 shrink-0" />
              {error}
            </p>
          )}

          <button
            type="submit"
            disabled={!password || busy}
            className="mt-3 flex w-full items-center justify-center gap-2 rounded-xl bg-gradient-to-r from-accent to-accent-strong px-3 py-2.5 text-xs font-semibold text-accent-contrast shadow-soft transition hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-40"
          >
            {busy && <FiLoader className="animate-spin" />}
            {busy ? 'Checking…' : 'Sign in'}
          </button>
        </form>

        <p className="mt-4 text-center text-[10px] leading-relaxed text-faint">
          Runs locally on Ollama. Change the password with
          <br />
          <code className="font-mono">node src/auth/setup.js "new password"</code>
        </p>
      </div>
    </div>
  );
}
