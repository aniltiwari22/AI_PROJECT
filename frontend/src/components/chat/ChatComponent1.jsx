import React from 'react';
import { FiUser, FiCpu } from 'react-icons/fi';

export default function ChatComponent1({ message }) {
  const isUser = message.role === 'user';
  const isSystem = message.role === 'system';

  return (
    <div className={`flex gap-4 max-w-4xl mx-auto ${isUser ? 'flex-row-reverse' : ''}`}>
      <div className={`h-9 w-9 rounded-lg flex items-center justify-center shrink-0 border ${
        isUser ? 'bg-blue-600/20 border-blue-500/40 text-blue-400' : 
        isSystem ? 'bg-slate-800 border-slate-700 text-slate-400' : 
        'bg-cyan-600/20 border-cyan-500/40 text-cyan-400'
      }`}>
        {isUser ? <FiUser /> : <FiCpu />}
      </div>
      <div className={`px-4 py-3 rounded-xl max-w-[85%] border text-sm leading-relaxed ${
        isUser ? 'bg-blue-600/10 border-blue-500/20 text-blue-100' :
        isSystem ? 'bg-slate-900/50 border-slate-800 text-slate-400 font-mono text-xs' :
        'bg-slate-900 border-slate-800 text-slate-200'
      }`}>
        {message.text}
      </div>
    </div>
  );
}