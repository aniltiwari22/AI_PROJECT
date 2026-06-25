const { generateCompletion } = require('../config/ollama');
const repository1 = require('../repositories/repository1');

function isGreeting(prompt) {
  return /^(hi|hello|hey|hii|hola|namaste|good morning|good afternoon|good evening)[!. ]*$/i.test(prompt.trim());
}

function cleanResponse(responseText) {
  return responseText
    .replace(/^hello!?\s*i'?m\s+ashu,?\s+a\s+codex\s+ai\.?\s*/i, 'Hi. ')
    .replace(/^as\s+ashu\s+codex\s+ai,?\s*/i, '')
    .replace(/^here'?s\s+a\s+brief\s+introduction:?\s*/i, '')
    .trim();
}

async function processPrompt(prompt) {
  const normalizedPrompt = String(prompt || '').trim();

  if (!normalizedPrompt) {
    const error = new Error('Prompt is required');
    error.statusCode = 400;
    throw error;
  }

  if (isGreeting(normalizedPrompt)) {
    const responseText = 'Hi! How can I help?';
    await repository1.saveLog({ prompt: normalizedPrompt, response: responseText });
    return responseText;
  }

  const systemPrompt = 'You are Ashu Codex AI. Do not introduce yourself. Answer only the user request. Use the shortest useful response. Maximum 70 words unless the user asks for more detail.';
  const aiResponse = await generateCompletion(undefined, normalizedPrompt, systemPrompt);
  const responseText = cleanResponse(aiResponse.response || '');

  await repository1.saveLog({ prompt: normalizedPrompt, response: responseText });

  return responseText;
}

module.exports = {
  processPrompt
};
