// Splits assistant text into alternating prose and fenced-code blocks.
// Kept dependency-free and free of JSX so it stays directly testable.
export function splitFencedBlocks(text) {
  const blocks = [];
  const fence = /```(\w+)?[ \t]*\n?([\s\S]*?)```/g;
  let lastIndex = 0;
  let match;

  while ((match = fence.exec(text)) !== null) {
    if (match.index > lastIndex) {
      blocks.push({ type: 'text', content: text.slice(lastIndex, match.index) });
    }
    blocks.push({ type: 'code', lang: match[1] || '', content: match[2].replace(/\n$/, '') });
    lastIndex = match.index + match[0].length;
  }

  const rest = text.slice(lastIndex);
  const openFence = rest.indexOf('```');

  // An unterminated fence means the reply was cut off mid-block; render what
  // arrived as code rather than leaking raw backticks into the prose.
  if (openFence !== -1) {
    if (openFence > 0) blocks.push({ type: 'text', content: rest.slice(0, openFence) });
    const remainder = rest.slice(openFence + 3);
    const newline = remainder.indexOf('\n');
    const lang = newline === -1 ? remainder.trim() : remainder.slice(0, newline).trim();
    const body = newline === -1 ? '' : remainder.slice(newline + 1);
    blocks.push({ type: 'code', lang, content: body });
  } else if (rest) {
    blocks.push({ type: 'text', content: rest });
  }

  return blocks;
}
