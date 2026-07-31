import React, { useState, useEffect, useRef, useCallback } from 'react';
import {
  FiSend, FiTerminal, FiLayers, FiMenu, FiX, FiTrash2, FiPlus,
  FiArrowDown, FiPaperclip, FiSquare, FiSun, FiMoon, FiActivity, FiHeart, FiBarChart2, FiLogOut
} from 'react-icons/fi';
import ChatComponent1 from './components/chat/ChatComponent1';
import Attachments from './components/chat/Attachments';
import {
  submitPromptToEngine, fetchEngineHealth, uploadFile, createVoiceSession, logVoiceTurn,
  fetchModels, fetchSystem, fetchRecentFiles,
  fetchRepos, previewRepo, indexRepo, removeRepo,
  login, logout, hasToken, setUnauthenticatedHandler,
  fetchConversations, fetchConversation, createConversation, appendMessage,
  updateConversation, deleteConversation, searchConversations,
  fetchStorage, fetchModelInventory, fetchIndexStatus
} from './services/service1';
import ConversationList from './components/workspace/ConversationList';
import { SystemOverview, ModelsLoaded, StorageBreakdown } from './components/workspace/SystemPanels';
import LoginScreen from './components/auth/LoginScreen';
import ContextRail from './components/workspace/ContextRail';
import ModelPicker from './components/workspace/ModelPicker';
import TopBar from './components/workspace/TopBar';
import RepoPanel from './components/workspace/RepoPanel';
import Dashboard from './components/workspace/Dashboard';
import { resolveInitialTheme, applyTheme } from './lib/theme';
import ActivityPanel from './components/workspace/ActivityPanel';
import SystemView from './components/workspace/SystemView';
import VectorsView from './components/workspace/VectorsView';
import useVoice from './hooks/useVoice';
import VoiceControls, { VoiceStatus } from './components/voice/VoiceControls';

const WELCOME = { id: 'welcome', role: 'system', text: 'Ashu Codex AI is ready' };

// Versioned so a future shape change discards old data instead of crashing on it.
const STORAGE_KEY = 'ashu-codex.chat.v1';
// Keeps the stored conversation well inside the ~5MB localStorage quota.
const MAX_PERSISTED = 60;
// Matches the Telegram bot's window so both surfaces behave the same.
const MAX_HISTORY_TURNS = 8;

function loadConversation() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return [WELCOME];
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed) || !parsed.length) return [WELCOME];
    const clean = parsed.filter((m) => m && typeof m.id === 'string' && typeof m.text === 'string');
    return clean.length ? clean : [WELCOME];
  } catch {
    return [WELCOME];
  }
}

function saveConversation(messages) {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(messages.slice(-MAX_PERSISTED)));
  } catch {
    // Quota exceeded or storage disabled — persistence is a convenience.
  }
}

const NAV = [
  { id: 'chat', label: 'Chat', Icon: FiTerminal },
  { id: 'health', label: 'Health', Icon: FiHeart },
  { id: 'analytics', label: 'Benchmark', Icon: FiBarChart2 },
  { id: 'vectors', label: 'Vectors & RAG', Icon: FiLayers }
];

const STATUS = {
  healthy: { dot: 'bg-success', label: 'Online' },
  degraded: { dot: 'bg-warm', label: 'Degraded' },
  offline: { dot: 'bg-danger', label: 'Offline' },
  checking: { dot: 'bg-faint', label: 'Connecting' }
};

function StatusPill({ status, detail }) {
  const s = STATUS[status] || STATUS.checking;
  return (
    <span
      title={detail}
      className="inline-flex items-center gap-2 rounded-full border border-line bg-surface/60 px-2.5 py-1 text-[11px] font-medium text-muted"
    >
      <span className={`h-1.5 w-1.5 rounded-full ${s.dot} ${status === 'healthy' ? 'animate-breathe' : ''}`} />
      {s.label}
    </span>
  );
}

/** The user turn immediately preceding a reply — what the answer answers. */
function questionBefore(messages, replyId) {
  const index = messages.findIndex((m) => m.id === replyId);
  for (let i = index - 1; i >= 0; i -= 1) {
    if (messages[i].role === 'user') return messages[i].text;
  }
  return '';
}

function Thinking({ stage }) {
  return (
    <div className="animate-fade-up mx-auto flex w-full max-w-3xl gap-3">
      <span className="relative flex h-7 w-7 shrink-0 items-center justify-center">
        <span className="absolute inset-0 animate-breathe rounded-lg bg-gradient-to-br from-accent to-warm" />
        <span className="relative font-mono text-[11px] font-bold text-accent-contrast">A</span>
      </span>
      <div className="flex items-center gap-2 pt-1.5">
        <span className="flex gap-1">
          {[0, 1, 2].map((i) => (
            <span
              key={i}
              className="animate-bounce-dot h-1.5 w-1.5 rounded-full bg-accent"
              style={{ animationDelay: `${i * 0.15}s` }}
            />
          ))}
        </span>
        {stage && <span className="text-xs text-faint">{stage}…</span>}
      </div>
    </div>
  );
}

export default function App() {
  // Every API route needs a session now, so the shell only mounts once there
  // is a token. A stored token is trusted optimistically — the first request
  // that comes back 401 clears it and brings this screen straight back.
  const [authed, setAuthed] = useState(hasToken);

  useEffect(() => { setUnauthenticatedHandler(() => setAuthed(false)); }, []);

  if (!authed) {
    return <LoginScreen login={login} onAuthenticated={() => setAuthed(true)} />;
  }

  return <Workspace onSignOut={async () => { await logout(); setAuthed(false); }} />;
}

function Workspace({ onSignOut }) {
  const [messages, setMessages] = useState(loadConversation);
  const [input, setInput] = useState('');
  const [isTyping, setIsTyping] = useState(false);
  const [navOpen, setNavOpen] = useState(false);
  const [health, setHealth] = useState('checking');
  const [healthDetail, setHealthDetail] = useState('');
  const [atBottom, setAtBottom] = useState(true);
  const [attachments, setAttachments] = useState([]);
  const [stage, setStage] = useState('');
  const [theme, setTheme] = useState(resolveInitialTheme);
  const [healthRaw, setHealthRaw] = useState(null);
  const [steps, setSteps] = useState([]);
  const [runMeta, setRunMeta] = useState(null);
  const [inspectorOpen, setInspectorOpen] = useState(
    () => localStorage.getItem('ashu-codex.inspector') === 'open'
  );
  const [view, setView] = useState('chat');
  const [language, setLanguage] = useState(() => localStorage.getItem('ashu-codex.voice.lang') || 'en-IN');
  const [autoSpeak, setAutoSpeak] = useState(() => localStorage.getItem('ashu-codex.voice.speak') !== 'false');
  const [models, setModels] = useState([]);
  const [model, setModel] = useState(() => localStorage.getItem('ashu-codex.model') || '');
  // Collapsed by default. Three permanent panels left the conversation with
  // 48% of the window; the rails earn their space only when you open them.
  const [railCollapsed, setRailCollapsed] = useState(
    () => localStorage.getItem('ashu-codex.rail') !== 'open'
  );
  const [system, setSystem] = useState(null);
  const [recentFiles, setRecentFiles] = useState([]);
  const [repos, setRepos] = useState([]);
  const [repoPreview, setRepoPreview] = useState(null);
  const [repoProgress, setRepoProgress] = useState(null);
  const [indexing, setIndexing] = useState(false);
  const [conversations, setConversations] = useState([]);
  const [activeConversationId, setActiveConversationId] = useState(null);
  const [conversationSearch, setConversationSearch] = useState([]);
  const [storage, setStorage] = useState(null);
  const [modelInventory, setModelInventory] = useState([]);

  const scrollRef = useRef(null);
  const chatEndRef = useRef(null);
  const textareaRef = useRef(null);
  const fileInputRef = useRef(null);
  const abortRef = useRef(null);
  const voiceRef = useRef(null);
  const voiceSessionRef = useRef(null);
  // Marks the current turn as voice-originated so it gets logged to VoiceLogs.
  const voiceTurnRef = useRef(null);
  // runPrompt has an empty dependency array, so reading these from the closure
  // would freeze them at first render: switching language or muting the
  // speaker would never reach the voice log. Refs keep them current.
  const languageRef = useRef(language);
  const autoSpeakRef = useRef(autoSpeak);
  const modelRef = useRef(model);
  // runPrompt has an empty dependency array; without a ref it would persist
  // every turn into whichever thread was open when the app first rendered.
  const conversationRef = useRef(null);

  const uploading = attachments.some((a) => a.status === 'uploading');
  const hasConversation = messages.some((m) => m.role !== 'system');
  const last = messages[messages.length - 1];
  const lastReplyId = last && last.role !== 'user' && last.role !== 'system' ? last.id : null;

  useEffect(() => { applyTheme(theme); }, [theme]);

  // Persist only once generation settles: writing on every streamed token
  // would hammer localStorage hundreds of times per reply.
  useEffect(() => { if (!isTyping) saveConversation(messages); }, [messages, isTyping]);

  // Only follow the conversation when the user hasn't scrolled away to read.
  useEffect(() => {
    if (hasConversation && atBottom) chatEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages, isTyping, hasConversation, atBottom]);

  useEffect(() => {
    const el = textareaRef.current;
    if (!el) return;
    el.style.height = 'auto';
    el.style.height = `${Math.min(el.scrollHeight, 200)}px`;
  }, [input]);

  useEffect(() => {
    let active = true;
    const check = async () => {
      const r = await fetchEngineHealth();
      if (!active) return;
      setHealth(r.status);
      setHealthRaw(r.raw || null);
      setHealthDetail(
        r.status === 'offline'
          ? 'Cannot reach the backend'
          : [r.ollama?.model && `Model: ${r.ollama.model}`, r.database?.connected && 'Database connected']
              .filter(Boolean).join(' · ')
      );
    };
    check();
    const id = setInterval(check, 30000);
    return () => { active = false; clearInterval(id); };
  }, []);

  useEffect(() => () => abortRef.current?.abort(), []);

  // Installed models for the composer picker. If the stored choice is no longer
  // installed, fall back to the backend default rather than sending a name
  // Ollama would try to pull.
  useEffect(() => {
    let active = true;
    fetchModels().then(({ models: list, default: fallback }) => {
      if (!active || !list.length) return;
      setModels(list);
      setModel((current) => (list.some((m) => m.name === current) ? current : fallback));
    });
    return () => { active = false; };
  }, []);

  useEffect(() => {
    let active = true;
    fetchRepos().then((list) => { if (active) setRepos(list); });
    return () => { active = false; };
  }, []);

  const handleRepoPreview = useCallback(async (root) => {
    const result = await previewRepo(root);
    setRepoPreview(result.error ? { error: result.error } : result);
  }, []);

  const handleRepoIndex = useCallback(async (root) => {
    setIndexing(true);
    setRepoProgress(null);
    // Embedding runs at roughly 20 files a minute here, so progress is streamed
    // rather than leaving the panel silent for several minutes.
    const summary = await indexRepo(root, { onProgress: setRepoProgress });
    setIndexing(false);
    setRepoProgress(null);
    setRepoPreview(null);
    setRepos(await fetchRepos());

    setMessages((prev) => [...prev, {
      id: `r-${Date.now()}`,
      role: 'system',
      text: summary.error
        ? `Could not index that folder: ${summary.error}`
        : `Indexed **${summary.name}** — ${summary.files} files, ${summary.chunks} chunks.` +
          (summary.failed?.length ? ` ${summary.failed.length} file(s) could not be read.` : '') +
          (summary.truncated ? ' Hit the file cap, so not everything was included.' : '')
    }]);
  }, []);

  const handleRepoRemove = useCallback(async (root) => {
    await removeRepo(root);
    setRepos(await fetchRepos());
  }, []);


  // --- conversations --------------------------------------------------------

  const refreshConversations = useCallback(async () => {
    setConversations(await fetchConversations());
  }, []);

  useEffect(() => { refreshConversations(); }, [refreshConversations]);

  // The effect keeps the ref in step with state, but it only runs after the
  // commit. Both switch paths below also set it synchronously, or a question
  // asked in the gap would be appended to the thread that was just left.
  useEffect(() => { conversationRef.current = activeConversationId; }, [activeConversationId]);

  const openConversation = useCallback(async (id) => {
    const conversation = await fetchConversation(id);
    if (!conversation) return;

    conversationRef.current = id;
    setActiveConversationId(id);
    setMessages(conversation.messages.length ? conversation.messages : [WELCOME]);
    setSteps([]);
    setRunMeta(null);
    setAtBottom(true);
    // Switching threads must not leave the previous one still generating.
    abortRef.current?.abort();
    abortRef.current = null;
    setIsTyping(false);
    voiceRef.current?.shutUp();
  }, []);

  const startConversation = useCallback(async () => {
    abortRef.current?.abort();
    abortRef.current = null;
    setIsTyping(false);
    setMessages([WELCOME]);
    setInput('');
    setStage('');
    setAttachments([]);
    setSteps([]);
    setRunMeta(null);
    conversationRef.current = null;
    setActiveConversationId(null);
    voiceRef.current?.shutUp();
    voiceSessionRef.current = null;
    textareaRef.current?.focus();
  }, []);

  const handleRenameConversation = useCallback(async (id, title) => {
    await updateConversation(id, { title });
    refreshConversations();
  }, [refreshConversations]);

  const handleTogglePin = useCallback(async (id, pinned) => {
    await updateConversation(id, { pinned });
    refreshConversations();
  }, [refreshConversations]);

  const handleDeleteConversation = useCallback(async (id) => {
    await deleteConversation(id);
    if (conversationRef.current === id) startConversation();
    refreshConversations();
  }, [refreshConversations, startConversation]);

  const handleConversationSearch = useCallback(async (query) => {
    if (query.trim().length < 2) return setConversationSearch([]);
    setConversationSearch(await searchConversations(query));
  }, []);

  // Dashboard panels. Polled slowly — storage walks the model directory.
  useEffect(() => {
    let active = true;
    const load = () => {
      fetchStorage().then((s) => { if (active) setStorage(s); });
      fetchModelInventory().then((m) => { if (active) setModelInventory(m); });
    };
    load();
    const id = setInterval(load, 60000);
    return () => { active = false; clearInterval(id); };
  }, []);

  // Machine metrics for the top bar. The first CPU reading is null by design —
  // usage needs two samples — so the value appears on the second tick.
  useEffect(() => {
    let active = true;
    const tick = () => fetchSystem().then((s) => { if (active) setSystem(s); });
    tick();
    const id = setInterval(tick, 5000);
    return () => { active = false; clearInterval(id); };
  }, []);

  // Refreshed whenever the conversation is reset, so the dashboard's recent
  // list reflects uploads made during the session rather than page-load state.
  useEffect(() => {
    if (hasConversation) return undefined;
    let active = true;
    fetchRecentFiles().then((files) => { if (active) setRecentFiles(files); });
    return () => { active = false; };
  }, [hasConversation]);

  useEffect(() => {
    modelRef.current = model;
    try { if (model) localStorage.setItem('ashu-codex.model', model); } catch { /* storage disabled */ }
  }, [model]);

  useEffect(() => {
    try {
      localStorage.setItem('ashu-codex.rail', railCollapsed ? 'closed' : 'open');
      localStorage.setItem('ashu-codex.inspector', inspectorOpen ? 'open' : 'closed');
    } catch { /* storage disabled */ }
  }, [railCollapsed, inspectorOpen]);

  const handleFilesPicked = useCallback(async (fileList) => {
    const files = Array.from(fileList || []);
    if (!files.length) return;

    const pending = files.map((file) => ({
      key: `${file.name}-${file.size}-${Math.random().toString(36).slice(2, 8)}`,
      filename: file.name,
      status: 'uploading'
    }));
    setAttachments((prev) => [...prev, ...pending]);

    await Promise.all(
      files.map(async (file, index) => {
        const { key } = pending[index];
        const result = await uploadFile(file);
        setAttachments((prev) =>
          prev.map((a) =>
            a.key === key
              ? result.success
                ? { ...a, status: 'ready', id: result.id, kind: result.kind, chars: result.chars,
                    pages: result.pages, truncated: result.truncated, warning: result.warning,
                    elapsedMs: result.elapsedMs, optimised: result.optimised, preview: result.preview,
                    indexing: Boolean(result.indexing) }
                : { ...a, status: 'error', error: result.error }
              : a
          )
        );
      })
    );
  }, []);

  /*
   * Uploads return as soon as the file is stored; embedding continues in the
   * background. Poll only while something is actually indexing, and stop as
   * soon as nothing is — an interval that runs forever for a flag nobody is
   * looking at is just noise.
   */
  useEffect(() => {
    const waiting = attachments.filter((a) => a.indexing && a.id);
    if (!waiting.length) return undefined;

    let active = true;
    const id = setInterval(async () => {
      for (const item of waiting) {
        const job = await fetchIndexStatus(item.id);
        if (!active) return;
        // A cleared job means it finished and aged out.
        if (!job || job.state === 'done' || job.state === 'failed') {
          setAttachments((prev) => prev.map((a) => (a.id === item.id ? { ...a, indexing: false } : a)));
        }
      }
    }, 3000);

    return () => { active = false; clearInterval(id); };
  }, [attachments]);

  const removeAttachment = useCallback((key) => {
    setAttachments((prev) => prev.filter((a) => a.key !== key));
  }, []);

  // Shows what was actually extracted from a file. A PDF that read as garbage
  // looks identical to one that read cleanly until you can see the text.
  const previewAttachment = useCallback((item) => {
    setMessages((prev) => [
      ...prev,
      {
        id: `p-${Date.now()}`,
        role: 'system',
        text: `**${item.filename}** — first ${item.preview?.length || 0} characters as read:\n\n\`\`\`\n${item.preview || '(nothing extracted)'}\n\`\`\``
      }
    ]);
    setAtBottom(true);
  }, []);

  // Aborting the fetch closes the socket, which the backend detects and uses to
  // cancel the Ollama request — otherwise the CPU keeps generating unseen.
  const stopGeneration = useCallback(() => {
    abortRef.current?.abort();
    abortRef.current = null;
  }, []);

  const handleClear = useCallback(() => {
    // Cancel any in-flight generation: without this the model kept running
    // against a conversation the user had already discarded.
    abortRef.current?.abort();
    abortRef.current = null;
    setIsTyping(false);
    setMessages([WELCOME]);
    setInput('');
    setStage('');
    setNavOpen(false);
    setAtBottom(true);
    setAttachments([]);
    // Stop any speech and start a fresh voice session — otherwise the new
    // conversation keeps talking over the user and its turns are logged
    // against the discarded session.
    voiceRef.current?.shutUp();
    voiceSessionRef.current = null;
    voiceTurnRef.current = null;
    setSteps([]);
    setRunMeta(null);
    try { localStorage.removeItem(STORAGE_KEY); } catch { /* storage disabled */ }
    textareaRef.current?.focus();
  }, []);

  const handleScroll = useCallback(() => {
    const el = scrollRef.current;
    if (!el) return;
    setAtBottom(el.scrollHeight - el.scrollTop - el.clientHeight < 90);
  }, []);

  const runPrompt = useCallback(async (promptText, base, fileIds = [], restoreAttachments) => {
    setIsTyping(true);

    // A thread is created on the first question, not by the New button — an
    // empty thread in the sidebar is noise.
    let conversationId = conversationRef.current;
    if (!conversationId) {
      const created = await createConversation(promptText);
      if (created) {
        conversationId = created.id;
        conversationRef.current = created.id;
        setActiveConversationId(created.id);
      }
    }
    if (conversationId) {
      appendMessage(conversationId, { role: 'user', text: promptText, fileIds });
      refreshConversations();
    }

    setAtBottom(true);
    setSteps([]);
    setRunMeta(null);

    // Prior turns only: `base` ends with the message being asked, and the
    // backend appends the prompt itself, so including it would duplicate it.
    const history = base
      .slice(0, -1)
      .filter((m) => m.role === 'user' || m.role === 'assistant')
      .slice(-MAX_HISTORY_TURNS * 2)
      .map((m) => ({ role: m.role, content: m.text }));

    const replyId = `a-${Date.now()}`;
    setMessages([...base, { id: replyId, role: 'assistant', text: '', origin: null, sources: [] }]);

    const patch = (changes) =>
      setMessages((prev) => prev.map((m) => (m.id === replyId ? { ...m, ...changes } : m)));

    const controller = new AbortController();
    abortRef.current = controller;
    voiceRef.current?.beginStream();

    const result = await submitPromptToEngine(promptText, history, fileIds, {
      signal: controller.signal,
      // Read through a ref: runPrompt has an empty dependency array, so the
      // closure would otherwise pin whichever model was selected at mount.
      model: modelRef.current,
      onStage: (event) => {
        // Steps arrive as structured objects now; a running step is replaced by
        // its completed version so the panel does not show duplicates.
        if (typeof event === 'string') { setStage(event); return; }
        setStage(event.label || '');
        setSteps((prev) => {
          const next = prev.filter((p) => !(p.key === event.key && p.status === 'running'));
          return [...next, event];
        });
      },
      onReset: () => patch({ text: '' }),
      onToken: (_chunk, full) => {
        patch({ text: full });
        // Speak completed sentences as they arrive rather than waiting for the
        // whole answer — on this hardware that is a ~35s difference.
        voiceRef.current?.pushStream(full);
      }
    });

    abortRef.current = null;

    if (result.stopped) {
      voiceRef.current?.shutUp();
      patch({
        role: 'assistant',
        text: result.data || 'Stopped before any output.',
        origin: null, sources: [], stopped: true
      });
    } else {
      setRunMeta({ totalMs: result.totalMs, origin: result.origin, confidence: result.confidence });
      patch({
        role: result.success ? 'assistant' : 'error',
        text: result.success ? result.data : result.error,
        origin: result.origin,
        confidence: result.confidence,
        sources: result.sources || [],
        timeline: result.timeline,
        totalMs: result.totalMs,
        telemetry: result.telemetry
      });
      // Put the uploads back so a failed send can simply be retried.
      if (!result.success) restoreAttachments?.();
      // Flush any trailing text the sentence-splitter has not spoken yet;
      // earlier sentences were already spoken as they streamed in.
      if (result.success && result.data) voiceRef.current?.endStream(result.data);
    }

    if (conversationId) {
      appendMessage(conversationId, {
        role: result.success ? 'assistant' : 'error',
        text: result.success ? result.data : result.error,
        origin: result.origin,
        confidence: result.confidence,
        sources: result.sources,
        telemetry: result.telemetry,
        totalMs: result.totalMs
      });
      refreshConversations();
    }

    // Log voice-originated turns to VoiceLogs.xlsx. Only voice turns — a typed
    // question already lands in AssistantLogs and would double-count here.
    const voiceTurn = voiceTurnRef.current;
    voiceTurnRef.current = null;
    if (voiceTurn) {
      if (!voiceSessionRef.current) voiceSessionRef.current = await createVoiceSession(languageRef.current);
      logVoiceTurn({
        sessionId: voiceSessionRef.current,
        language: languageRef.current,
        transcript: voiceTurn.transcript,
        origin: result.origin,
        confidence: result.confidence,
        responseMs: Date.now() - voiceTurn.startedAt,
        answer: result.data,
        spoken: autoSpeakRef.current,
        interrupted: Boolean(result.stopped)
      });
    }

    setStage('');
    setIsTyping(false);
    textareaRef.current?.focus();
  }, []);

  const sendPrompt = useCallback((rawText) => {
    const promptText = rawText.trim();
    if (!promptText || isTyping || uploading) return;

    const attached = attachments.filter((a) => a.status === 'ready');
    const base = [...messages, {
      id: `u-${Date.now()}`,
      role: 'user',
      text: promptText,
      files: attached.map((a) => a.filename),
      // The ids matter as much as the names: without them Regenerate re-asked
      // the question with no documents attached, so a file-grounded answer
      // quietly became a guess from the model's own knowledge.
      fileIds: attached.map((a) => a.id)
    }];

    setMessages(base);
    setInput('');
    setAttachments([]);
    runPrompt(promptText, base, attached.map((a) => a.id), () => setAttachments(attached));
  }, [isTyping, uploading, attachments, messages, runPrompt]);

  // Voice reuses the exact same send path as typing — the transcript is just
  // another way to produce a prompt, so there is no second retrieval pipeline.
  const voice = useVoice({
    language,
    autoSpeak,
    onUtterance: (transcript) => {
      voiceTurnRef.current = { transcript, startedAt: Date.now() };
      sendPrompt(transcript);
    }
  });

  useEffect(() => {
    try {
      localStorage.setItem('ashu-codex.voice.lang', language);
      localStorage.setItem('ashu-codex.voice.speak', String(autoSpeak));
    } catch {
      /* storage disabled */
    }
  }, [language, autoSpeak]);

  useEffect(() => { voiceRef.current = voice; }, [voice]);
  useEffect(() => { languageRef.current = language; }, [language]);
  useEffect(() => { autoSpeakRef.current = autoSpeak; }, [autoSpeak]);

  const handleRegenerate = useCallback(() => {
    if (isTyping) return;
    const lastUserIndex = messages.map((m) => m.role).lastIndexOf('user');
    if (lastUserIndex === -1) return;
    const base = messages.slice(0, lastUserIndex + 1);
    setMessages(base);
    // Re-attach whatever that turn was asked with, so regenerating a question
    // about a document answers from the document again.
    runPrompt(messages[lastUserIndex].text, base, messages[lastUserIndex].fileIds || []);
  }, [isTyping, messages, runPrompt]);

  const handleKeyDown = (e) => {
    // isComposing guards IME input (Hindi, Chinese, Japanese…), where Enter
    // confirms the candidate word and must not send the message.
    if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
      e.preventDefault();
      sendPrompt(input);
    }
  };

  const canSend = input.trim().length > 0 && !isTyping && !uploading;

  // Only counters the backend actually reports. Anything it does not know is
  // omitted rather than shown as a zero, which reads as "none" when it means
  // "unmeasured".
  const dashboardStats = [
    healthRaw?.database?.chatLogCount && {
      label: 'Questions answered', value: healthRaw.database.chatLogCount.toLocaleString(),
      title: 'Total prompts recorded in the local database'
    },
    healthRaw?.cache?.entries && {
      label: 'Cached answers', value: healthRaw.cache.entries.toLocaleString(),
      title: `Reused instantly on a close paraphrase (${healthRaw.cache.totalHits || 0} hits so far)`
    },
    healthRaw?.knowledge?.documents && {
      label: 'Documents indexed', value: healthRaw.knowledge.documents.toLocaleString(),
      title: `${healthRaw.knowledge.chunks || 0} searchable chunks`
    },
    system?.memory && {
      label: 'Memory', value: `${system.memory.usedGb}/${system.memory.totalGb}GB`,
      title: `${system.memory.percent}% of system RAM in use`
    }
  ].filter(Boolean);

  return (
    <div className="aurora flex h-screen overflow-hidden bg-bg font-sans text-content">
      {navOpen && (
        <button
          type="button"
          aria-label="Close menu"
          onClick={() => setNavOpen(false)}
          className="animate-fade-in fixed inset-0 z-20 bg-bg/70 backdrop-blur-sm md:hidden"
        />
      )}

      <aside
        className={`glass fixed inset-y-0 left-0 z-30 flex w-64 flex-col justify-between border-r border-line p-3 transition-transform duration-300 md:static md:z-auto md:visible md:translate-x-0 ${
          // `invisible` (rather than only translating it away) keeps the closed
          // drawer out of the tab order and the accessibility tree on mobile.
          navOpen ? 'visible translate-x-0' : 'invisible -translate-x-full'
        }`}
      >
        <div className="flex min-h-0 flex-1 flex-col">
          <div className="mb-6 flex shrink-0 items-center justify-between px-1 py-1.5">
            <div className="flex items-center gap-2.5">
              <span className="flex h-8 w-8 items-center justify-center rounded-xl bg-gradient-to-br from-accent to-warm shadow-soft">
                <span className="font-mono text-sm font-bold text-accent-contrast">A</span>
              </span>
              <span className="text-sm font-semibold tracking-tight">Ashu Codex</span>
              <span className="rounded-md border border-accent/30 bg-accent/10 px-1.5 py-0.5 font-mono text-[9px] font-semibold text-accent">
                v2.2
              </span>
            </div>
            <button
              type="button"
              aria-label="Close menu"
              onClick={() => setNavOpen(false)}
              className="rounded-lg p-1.5 text-faint transition hover:bg-surface hover:text-content md:hidden"
            >
              <FiX />
            </button>
          </div>

          <nav className="mb-3 space-y-0.5">
            {NAV.map(({ id, label, Icon }) => (
              <button
                key={id}
                type="button"
                onClick={() => {
                  setView(id);
                  setNavOpen(false);
                }}
                className={`flex w-full items-center gap-2.5 rounded-xl px-3 py-2 text-xs font-medium transition ${
                  view === id ? 'bg-surface text-content' : 'text-muted hover:bg-surface/60 hover:text-content'
                }`}
              >
                <Icon className={view === id ? 'text-accent' : ''} /> {label}
              </button>
            ))}

            <button
              type="button"
              disabled
              title="Not available yet"
              className="flex w-full cursor-not-allowed items-center gap-2.5 rounded-xl px-3 py-2 text-xs font-medium text-faint"
            >
              <FiLayers /> Vectors &amp; RAG
              <span className="ml-auto rounded-md bg-surface px-1.5 py-0.5 text-[9px] uppercase tracking-wide">Soon</span>
            </button>
          </nav>

          {/* Takes the remaining height and scrolls on its own, so the status
              controls below stay pinned. */}
          {view === 'chat' && (
            <ConversationList
              conversations={conversations}
              activeId={activeConversationId}
              onSelect={(id) => { openConversation(id); setNavOpen(false); }}
              onCreate={() => { startConversation(); setNavOpen(false); }}
              onRename={handleRenameConversation}
              onDelete={handleDeleteConversation}
              onTogglePin={handleTogglePin}
              searchResults={conversationSearch}
              onSearch={handleConversationSearch}
            />
          )}
        </div>

        <div className="shrink-0 space-y-3 border-t border-line pt-3">
          <div className="flex items-center justify-between px-1">
            <StatusPill status={health} detail={healthDetail} />
            <button
              type="button"
              onClick={() => setInspectorOpen((v) => !v)}
              aria-label={inspectorOpen ? 'Hide AI activity panel' : 'Show AI activity panel'}
              title="Toggle AI activity panel"
              className={'hidden rounded-lg border border-line bg-surface/60 p-1.5 transition xl:block ' + (inspectorOpen ? 'text-accent' : 'text-muted hover:text-accent')}
            >
              <FiActivity className="text-xs" />
            </button>

            <button
              type="button"
              onClick={() => setTheme((t) => (t === 'dark' ? 'light' : 'dark'))}
              aria-label={`Switch to ${theme === 'dark' ? 'light' : 'dark'} theme`}
              title={`Switch to ${theme === 'dark' ? 'light' : 'dark'} theme`}
              className="rounded-lg border border-line bg-surface/60 p-1.5 text-muted transition hover:text-accent"
            >
              {theme === 'dark' ? <FiSun className="text-xs" /> : <FiMoon className="text-xs" />}
            </button>

            <button
              type="button"
              onClick={onSignOut}
              aria-label="Sign out"
              title="Sign out — revokes this session on the server"
              className="rounded-lg border border-line bg-surface/60 p-1.5 text-muted transition hover:text-danger"
            >
              <FiLogOut className="text-xs" />
            </button>
          </div>

          {hasConversation && (
            <button
              type="button"
              onClick={handleClear}
              className="flex w-full items-center gap-2.5 rounded-xl px-3 py-2 text-xs font-medium text-faint transition hover:bg-danger/10 hover:text-danger"
            >
              <FiTrash2 /> Clear conversation
            </button>
          )}
        </div>
      </aside>

      {/* Workspace column: cockpit on top, then chat beside the inspector. */}
      <div className="flex min-w-0 flex-1 flex-col">
        <TopBar
          health={healthRaw}
          system={system}
          right={<StatusPill status={health} detail={healthDetail} />}
        />

        <div className="flex min-h-0 flex-1">
          {/* What the assistant can see, always visible while working on code. */}
          {view === 'chat' && (
            <ContextRail
              items={attachments}
              onRemove={removeAttachment}
              onAdd={() => fileInputRef.current?.click()}
              onPreview={previewAttachment}
              collapsed={railCollapsed}
              onToggle={() => setRailCollapsed((c) => !c)}
              hasRepos={repos.length > 0}
              repo={(
                <RepoPanel
                  repos={repos}
                  preview={repoPreview}
                  progress={repoProgress}
                  busy={indexing}
                  onPreview={handleRepoPreview}
                  onIndex={handleRepoIndex}
                  onRemove={handleRepoRemove}
                />
              )}
            />
          )}

      <main className="flex min-w-0 flex-1 flex-col">
        <header className="flex h-14 shrink-0 items-center gap-3 border-b border-line px-4 md:hidden">
          <button
            type="button"
            aria-label="Open menu"
            onClick={() => setNavOpen(true)}
            className="rounded-lg p-2 text-muted transition hover:bg-surface hover:text-content"
          >
            <FiMenu />
          </button>
          <span className="flex items-center gap-2">
            <span className="flex h-6 w-6 items-center justify-center rounded-lg bg-gradient-to-br from-accent to-warm">
              <span className="font-mono text-[10px] font-bold text-accent-contrast">A</span>
            </span>
            <span className="text-sm font-semibold">Ashu Codex</span>
          </span>
          <span className="ml-auto flex items-center gap-2">
            <StatusPill status={health} detail={healthDetail} />
          </span>
        </header>

        <div className="relative min-h-0 flex-1">
          <div ref={scrollRef} onScroll={handleScroll} className="h-full overflow-y-auto">
            {view === 'vectors' ? (
              <VectorsView />
            ) : view !== 'chat' ? (
              <SystemView tab={view} />
            ) : hasConversation ? (
              <div className="space-y-7 px-4 py-8">
                {messages.map((m) => (
                  <ChatComponent1
                    key={m.id}
                    message={m}
                    canRegenerate={m.id === lastReplyId && !isTyping}
                    onRegenerate={handleRegenerate}
                    askedQuestion={questionBefore(messages, m.id)}
                  />
                ))}
                {isTyping && !last?.text && <Thinking stage={stage} />}
                <div ref={chatEndRef} className="h-1" />
              </div>
            ) : (
              <Dashboard
                onPick={sendPrompt}
                recentFiles={recentFiles}
                stats={dashboardStats}
              />
            )}
          </div>

          {hasConversation && !atBottom && (
            <button
              type="button"
              onClick={() => chatEndRef.current?.scrollIntoView({ behavior: 'smooth' })}
              aria-label="Scroll to latest"
              className="glass animate-fade-in absolute bottom-4 left-1/2 flex h-9 w-9 -translate-x-1/2 items-center justify-center rounded-full border border-line text-muted shadow-lift transition hover:text-accent"
            >
              <FiArrowDown className="text-sm" />
            </button>
          )}
        </div>

        <footer className="shrink-0 px-4 pb-4 pt-2">
          <form onSubmit={(e) => { e.preventDefault(); sendPrompt(input); }} className="mx-auto max-w-3xl">
            <VoiceStatus voice={voice} />
            {/* Below lg the context rail is hidden, so the chips stay as the
                only way to see and remove attachments on a narrow screen. */}
            <div className="lg:hidden">
              <Attachments attachments={attachments} onRemove={removeAttachment} />
            </div>

            <input
              ref={fileInputRef}
              type="file"
              multiple
              className="hidden"
              accept=".pdf,.docx,.pptx,.txt,.md,.csv,.json,.log,.xml,.yml,.yaml,.html,.js,.jsx,.mjs,.cjs,.ts,.tsx,.py,.java,.kt,.go,.rs,.c,.h,.cpp,.hpp,.cc,.cs,.rb,.php,.swift,.scala,.sql,.sh,.bash,.ps1,.bat,.css,.scss,.less,.vue,.svelte,.toml,.ini,.cfg,.conf,image/*"
              onChange={(e) => { handleFilesPicked(e.target.files); e.target.value = ''; }}
            />

            <div className="glass flex items-end gap-1.5 rounded-2xl border border-line p-2 shadow-lift transition focus-within:border-accent/50 focus-within:ring-4 focus-within:ring-accent/10">
              <button
                type="button"
                onClick={() => fileInputRef.current?.click()}
                aria-label="Attach a file"
                title="Attach PDF, image, or document"
                className="flex h-9 w-9 shrink-0 items-center justify-center rounded-xl text-faint transition hover:bg-surface hover:text-accent"
              >
                <FiPaperclip className="text-sm" />
              </button>

              <VoiceControls
                voice={voice}
                language={language}
                onLanguageChange={setLanguage}
                autoSpeak={autoSpeak}
                onToggleAutoSpeak={() => setAutoSpeak((v) => !v)}
              />

              <textarea
                ref={textareaRef}
                rows={1}
                value={input}
                onChange={(e) => setInput(e.target.value)}
                onKeyDown={handleKeyDown}
                placeholder="Ask anything…"
                className="max-h-[200px] min-h-[28px] flex-1 resize-none bg-transparent px-1.5 py-1.5 text-[15px] leading-relaxed text-content placeholder:text-faint focus:outline-none"
              />

              {isTyping ? (
                <button
                  type="button"
                  onClick={stopGeneration}
                  aria-label="Stop generating"
                  title="Stop generating"
                  className="flex h-9 w-9 shrink-0 items-center justify-center rounded-xl bg-danger text-white transition hover:opacity-90"
                >
                  <FiSquare className="text-[11px]" fill="currentColor" />
                </button>
              ) : (
                <button
                  type="submit"
                  disabled={!canSend}
                  aria-label="Send message"
                  className={`flex h-9 w-9 shrink-0 items-center justify-center rounded-xl transition ${
                    canSend
                      ? 'bg-gradient-to-br from-accent to-accent-strong text-accent-contrast shadow-soft hover:opacity-90'
                      : 'cursor-not-allowed bg-surface text-faint'
                  }`}
                >
                  <FiSend className="text-sm" />
                </button>
              )}
            </div>

            <div className="mt-2 flex items-center justify-between gap-3">
              <ModelPicker models={models} value={model} onChange={setModel} disabled={isTyping} />
              <p className="text-[10px] text-faint">
                Runs locally on Ollama · responses may be inaccurate
              </p>
            </div>
          </form>
        </footer>
      </main>

          {/* Inspector: hidden on narrow screens where the chat needs the width. */}
          {inspectorOpen && (
            <aside className="hidden w-64 shrink-0 overflow-y-auto border-l border-line xl:block">
              <ActivityPanel
                steps={steps}
                totalMs={runMeta?.totalMs}
                origin={runMeta?.origin}
                confidence={runMeta?.confidence}
                live={isTyping}
              />

              <div className="space-y-4 border-t border-line p-3">
                <SystemOverview system={system} />
                <ModelsLoaded models={modelInventory} />
                <StorageBreakdown storage={storage} />
              </div>
            </aside>
          )}
        </div>
      </div>
    </div>
  );
}
