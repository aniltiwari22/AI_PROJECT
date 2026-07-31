import React, { useState, useEffect } from 'react';
import { FiBookmark, FiCheck, FiX, FiLoader, FiZap } from 'react-icons/fi';
import { fetchSheets, curateAnswer } from '../../services/service1';

/**
 * Promotes an answer into the curated workbook.
 *
 * The workbook is the fastest source in the pipeline — a hit is returned with
 * no model call — and it was sitting empty while the request log showed the
 * same question reaching the model seven separate times at roughly 42 seconds
 * each. Curating was previously only possible by opening Excel by hand, which
 * is why nobody did it.
 */

// Which sheet a question most likely belongs in, from its own words. A guess
// the user can override beats making them choose from six every time.
function guessSheet(question, sheets) {
  const q = String(question || '').toLowerCase();
  const has = (name) => sheets.some((s) => s.name === name);

  if (/\b(error|exception|failed|failure|code \d|\d{4,})\b/.test(q) && has('Errors')) return 'Errors';
  if (/\b(select|insert|update|delete|join|query|sql|table)\b/.test(q) && has('SQL')) return 'SQL';
  if (/\b(api|endpoint|route|request|post|get|put)\b/.test(q) && has('APIs')) return 'APIs';
  if (/\b([a-z]+-\d+|jira|ticket|issue)\b/.test(q) && has('Jira')) return 'Jira';
  if (/\b(email|subject|mail|draft)\b/.test(q) && has('Emails')) return 'Emails';
  return sheets[0]?.name || 'FAQs';
}

/** Best-effort mapping of a question and answer onto a sheet's columns. */
function prefill(sheet, question, answer) {
  const values = {};
  for (const column of sheet.columns) values[column] = '';

  const put = (candidates, text) => {
    const column = sheet.columns.find((c) => candidates.includes(c));
    if (column) values[column] = text;
  };

  put(['Question', 'Problem', 'Name', 'Message', 'Subject'], question);
  put(['Answer', 'Solution', 'Description', 'Resolution', 'Body', 'Query'], answer);

  // Nothing matched — put the question in the first key column so the row is
  // at least findable, and the answer in the first column that is not a key.
  if (!Object.values(values).some(Boolean)) {
    values[sheet.keys[0] || sheet.columns[0]] = question;
    const spare = sheet.columns.find((c) => !sheet.keys.includes(c));
    if (spare) values[spare] = answer;
  }
  return values;
}

export default function SaveAnswer({ question, answer }) {
  const [open, setOpen] = useState(false);
  const [sheets, setSheets] = useState([]);
  const [sheetName, setSheetName] = useState('');
  const [values, setValues] = useState({});
  const [busy, setBusy] = useState(false);
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState('');

  useEffect(() => {
    if (!open || sheets.length) return;
    fetchSheets().then((list) => {
      if (!list.length) return;
      setSheets(list);
      const guessed = guessSheet(question, list);
      setSheetName(guessed);
      setValues(prefill(list.find((s) => s.name === guessed), question, answer));
    });
  }, [open, sheets.length, question, answer]);

  const changeSheet = (name) => {
    setSheetName(name);
    const sheet = sheets.find((s) => s.name === name);
    if (sheet) setValues(prefill(sheet, question, answer));
  };

  const save = async () => {
    setBusy(true);
    setError('');
    const result = await curateAnswer(sheetName, values);
    setBusy(false);

    if (result.success) {
      setSaved(true);
      setTimeout(() => { setOpen(false); }, 1400);
    } else {
      setError(result.error || 'Could not save');
    }
  };

  if (saved) {
    return (
      <span className="flex items-center gap-1 rounded-lg px-1.5 py-1 text-[11px] text-success">
        <FiCheck /> Saved to {sheetName}
      </span>
    );
  }

  if (!open) {
    return (
      <button
        type="button"
        onClick={() => setOpen(true)}
        title="Save this answer so the same question is answered instantly next time"
        className="flex items-center gap-1 rounded-lg px-1.5 py-1 text-[11px] text-faint transition hover:bg-surface hover:text-content"
      >
        <FiBookmark /> Save
      </button>
    );
  }

  const sheet = sheets.find((s) => s.name === sheetName);

  return (
    <div className="mt-2 w-full rounded-xl border border-line bg-surface/60 p-3">
      <div className="mb-2 flex items-center justify-between">
        <p className="flex items-center gap-1.5 text-[11px] font-semibold text-content">
          <FiZap className="text-accent" /> Save to knowledge base
        </p>
        <button type="button" onClick={() => setOpen(false)} aria-label="Cancel">
          <FiX className="text-xs text-faint hover:text-content" />
        </button>
      </div>

      <p className="mb-2.5 text-[10px] leading-snug text-faint">
        Answered from here with no model call — instant, instead of the ~40s a
        generated reply costs on this machine.
      </p>

      <label className="mb-2 block">
        <span className="mb-1 block text-[10px] text-muted">Sheet</span>
        <select
          value={sheetName}
          onChange={(e) => changeSheet(e.target.value)}
          className="w-full rounded-lg border border-line bg-surface px-2 py-1.5 text-[11px] text-content focus:border-accent/50 focus:outline-none"
        >
          {sheets.map((s) => <option key={s.name} value={s.name}>{s.name}</option>)}
        </select>
      </label>

      {sheet?.columns.map((column) => (
        <label key={column} className="mb-2 block">
          <span className="mb-1 block text-[10px] text-muted">
            {column}
            {sheet.keys.includes(column) && <span className="ml-1 text-accent">· matched against questions</span>}
          </span>
          <textarea
            rows={column === 'Answer' || column === 'Solution' || column === 'Body' ? 4 : 1}
            value={values[column] || ''}
            onChange={(e) => setValues((v) => ({ ...v, [column]: e.target.value }))}
            className="w-full resize-y rounded-lg border border-line bg-surface px-2 py-1.5 text-[11px] text-content focus:border-accent/50 focus:outline-none"
          />
        </label>
      ))}

      {error && <p className="mb-2 text-[10px] text-danger">{error}</p>}

      <button
        type="button"
        onClick={save}
        disabled={busy}
        className="flex w-full items-center justify-center gap-1.5 rounded-lg bg-gradient-to-r from-accent to-accent-strong px-3 py-2 text-[11px] font-semibold text-accent-contrast transition hover:opacity-90 disabled:opacity-40"
      >
        {busy ? <FiLoader className="animate-spin" /> : <FiBookmark />}
        {busy ? 'Saving…' : `Save to ${sheetName}`}
      </button>
    </div>
  );
}
