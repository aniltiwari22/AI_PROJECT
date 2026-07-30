import React, { useState } from 'react';
import { FiCopy, FiCheck, FiCornerDownRight } from 'react-icons/fi';

// Self-contained syntax highlighting. The project has no highlighter
// dependency and cannot install one offline, so this covers the common cases
// (comments, strings, numbers, keywords) across the languages a coding
// assistant actually emits. Output is React elements, never raw HTML.

const KEYWORDS = [
  // JS / TS
  'const', 'let', 'var', 'function', 'return', 'if', 'else', 'for', 'while', 'class', 'extends',
  'new', 'await', 'async', 'import', 'from', 'export', 'default', 'try', 'catch', 'finally',
  'throw', 'typeof', 'instanceof', 'delete', 'switch', 'case', 'break', 'continue', 'do', 'yield',
  'interface', 'implements', 'readonly', 'enum', 'namespace',
  // Python
  'def', 'elif', 'lambda', 'pass', 'raise', 'with', 'global', 'nonlocal', 'assert', 'del',
  // Go / C-family
  'func', 'package', 'struct', 'chan', 'defer', 'go', 'range', 'public', 'private', 'protected',
  'static', 'void', 'int', 'float', 'double', 'char', 'bool', 'string', 'long', 'short',
  // Shell / SQL
  'echo', 'then', 'fi', 'done', 'esac', 'select', 'where', 'insert', 'update', 'delete', 'create',
  'table', 'join', 'group', 'order'
];

const LITERALS = ['true', 'false', 'null', 'undefined', 'None', 'True', 'False', 'nil', 'self', 'this'];

const HASH_COMMENT_LANGS = new Set([
  'python', 'py', 'bash', 'sh', 'shell', 'zsh', 'yaml', 'yml', 'ruby', 'rb',
  'r', 'perl', 'toml', 'ini', 'dockerfile', 'makefile', 'conf', 'env'
]);

// Each token kind needs its own colour; mapping two kinds to the same token
// silently removes the distinction the highlighting exists for.
const TOKEN_CLASS = {
  comment: 'text-faint italic',
  string: 'text-success',
  number: 'text-warm',
  keyword: 'text-accent font-medium',
  literal: 'text-warm/90'
};

function buildPattern(lang) {
  const hash = HASH_COMMENT_LANGS.has(String(lang || '').toLowerCase());
  const comment = hash
    ? '#[^\\n]*|//[^\\n]*|/\\*[\\s\\S]*?\\*/'
    : '//[^\\n]*|/\\*[\\s\\S]*?\\*/';

  return new RegExp(
    [
      `(${comment})`,
      `("(?:[^"\\\\\\n]|\\\\.)*"|'(?:[^'\\\\\\n]|\\\\.)*'|\`(?:[^\`\\\\]|\\\\.)*\`)`,
      '(\\b\\d+(?:\\.\\d+)?\\b)',
      `(\\b(?:${LITERALS.join('|')})\\b)`,
      `(\\b(?:${KEYWORDS.join('|')})\\b)`
    ].join('|'),
    'g'
  );
}

function highlight(code, lang) {
  const pattern = buildPattern(lang);
  const nodes = [];
  let lastIndex = 0;
  let match;
  let i = 0;

  while ((match = pattern.exec(code)) !== null) {
    if (match.index > lastIndex) nodes.push(code.slice(lastIndex, match.index));

    const [full, comment, string, number, literal, keyword] = match;
    const kind = comment ? 'comment' : string ? 'string' : number ? 'number' : literal ? 'literal' : 'keyword';

    nodes.push(
      <span key={`t${i}`} className={TOKEN_CLASS[kind]}>
        {full}
      </span>
    );

    lastIndex = match.index + full.length;
    i += 1;
  }

  if (lastIndex < code.length) nodes.push(code.slice(lastIndex));
  return nodes;
}

export default function CodeBlock({ lang, content }) {
  const [copied, setCopied] = useState(false);
  const [wrap, setWrap] = useState(false);

  const lines = content.split('\n');
  const showLineNumbers = lines.length > 2;

  const handleCopy = async () => {
    try {
      await navigator.clipboard.writeText(content);
      setCopied(true);
      setTimeout(() => setCopied(false), 1600);
    } catch {
      // clipboard unavailable (insecure origin / permission denied)
    }
  };

  return (
    <div className="group/code my-3 overflow-hidden rounded-xl border border-line bg-surface/80 shadow-sm first:mt-0 last:mb-0">
      <div className="flex items-center justify-between border-b border-line bg-surface-strong/60 px-3 py-1.5">
        <div className="flex items-center gap-2">
          <div className="flex gap-1">
            <span className="h-2 w-2 rounded-full bg-line-strong" />
            <span className="h-2 w-2 rounded-full bg-line-strong" />
            <span className="h-2 w-2 rounded-full bg-line-strong" />
          </div>
          <span className="font-mono text-[10px] uppercase tracking-wider text-faint">{lang || 'code'}</span>
        </div>

        <div className="flex items-center gap-0.5 opacity-0 transition group-hover/code:opacity-100 focus-within:opacity-100">
          <button
            type="button"
            onClick={() => setWrap((w) => !w)}
            aria-label="Toggle line wrapping"
            title={wrap ? 'Disable wrapping' : 'Enable wrapping'}
            className={`rounded p-1 text-xs transition hover:bg-surface-strong ${wrap ? 'text-accent' : 'text-faint hover:text-content'}`}
          >
            <FiCornerDownRight />
          </button>
          <button
            type="button"
            onClick={handleCopy}
            aria-label="Copy code"
            className="flex items-center gap-1 rounded px-1.5 py-1 text-[10px] font-medium text-faint transition hover:bg-surface-strong hover:text-content"
          >
            {copied ? <FiCheck className="text-success" /> : <FiCopy />}
            {copied ? 'Copied' : 'Copy'}
          </button>
        </div>
      </div>

      <div className="overflow-x-auto">
        <pre className={`p-3 font-mono text-xs leading-[1.65] ${wrap ? 'whitespace-pre-wrap break-words' : 'whitespace-pre'}`}>
          <code className="text-content">
            {showLineNumbers
              ? lines.map((line, index) => (
                  <div key={index} className="table-row">
                    <span className="table-cell select-none pr-4 text-right text-faint/60">{index + 1}</span>
                    <span className="table-cell">{highlight(line, lang)}</span>
                  </div>
                ))
              : highlight(content, lang)}
          </code>
        </pre>
      </div>
    </div>
  );
}
