import React, { useState, useEffect, useRef } from 'react';
import { FiSend, FiCpu, FiTerminal, FiLayers } from 'react-icons/fi';
import ChatComponent1 from './components/chat/ChatComponent1';
import { submitPromptToEngine } from './services/service1';

export default function App() {
  const [messages, setMessages] = useState([
    { id: 1, role: 'system', text: 'Ashu Codex AI is ready.' }
  ]);
  const [input, setInput] = useState('');
  const [isTyping, setIsTyping] = useState(false);
  const chatEndRef = useRef(null);

  useEffect(() => {
    chatEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages]);

  const handleSendMessage = async (e) => {
    e.preventDefault();
    if (!input.trim()) return;

    const userMessage = { id: Date.now(), role: 'user', text: input };
    setMessages((prev) => [...prev, userMessage]);
    setInput('');
    setIsTyping(true);

    const result = await submitPromptToEngine(input);
    
    setMessages((prev) => [
      ...prev,
      { id: Date.now() + 1, role: 'assistant', text: result.success ? result.data : result.error }
    ]);
    setIsTyping(false);
  };

  return (
    <div className="flex h-screen bg-slate-950 text-slate-100 antialiased font-sans">
      <aside className="w-64 bg-slate-900 border-r border-slate-800 p-4 hidden md:flex flex-col justify-between">
        <div>
          <div className="flex items-center gap-3 px-2 py-3 mb-6 border-b border-slate-800">
            <FiCpu className="text-cyan-400 text-2xl animate-pulse" />
            <span className="font-bold tracking-wider bg-gradient-to-r from-cyan-400 to-blue-500 bg-clip-text text-transparent">
              ASHU CODEX AI
            </span>
          </div>
          <nav className="space-y-1">
            <button type="button" className="flex items-center gap-3 w-full px-3 py-2.5 rounded-lg bg-slate-800 text-cyan-400 font-medium">
              <FiTerminal /> Chat Interface
            </button>
            <button type="button" className="flex items-center gap-3 w-full px-3 py-2.5 rounded-lg text-slate-500 hover:text-slate-300 transition">
              <FiLayers /> Vectors & RAG
            </button>
          </nav>
        </div>
      </aside>

      <main className="flex-1 flex flex-col bg-slate-950">
        <header className="h-16 border-b border-slate-800 flex items-center justify-between px-6 bg-slate-900/40 backdrop-blur-md">
          <div className="flex items-center gap-2">
            <span className="h-2 w-2 rounded-full bg-emerald-500 animate-ping" />
            <span className="text-xs font-semibold text-slate-400">Services Active (Ollama)</span>
          </div>
        </header>

        <div className="flex-1 overflow-y-auto p-6 space-y-6">
          {messages.map((msg) => (
            <ChatComponent1 key={msg.id} message={msg} />
          ))}
          {isTyping && (
            <div className="flex gap-4 max-w-4xl mx-auto items-center text-slate-500 font-mono text-xs animate-pulse">
              <FiCpu className="animate-spin text-cyan-500" /> Checking resources and generating response...
            </div>
          )}
          <div ref={chatEndRef} />
        </div>

        <footer className="p-4 border-t border-slate-800/60 bg-gradient-to-t from-slate-950 to-transparent">
          <form onSubmit={handleSendMessage} className="max-w-4xl mx-auto relative flex items-center">
            <input
              type="text"
              value={input}
              onChange={(e) => setInput(e.target.value)}
              placeholder="Query workspace repository..."
              className="w-full bg-slate-900/90 border border-slate-800 rounded-xl py-3.5 pl-4 pr-14 text-sm focus:outline-none focus:border-cyan-500/80 focus:ring-1 focus:ring-cyan-500/30 transition shadow-inner"
            />
            <button type="submit" className="absolute right-2.5 p-2 bg-cyan-600 hover:bg-cyan-500 text-slate-950 rounded-lg transition-all">
              <FiSend />
            </button>
          </form>
        </footer>
      </main>
    </div>
  );
}
