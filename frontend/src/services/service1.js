const API_BASE = import.meta.env.VITE_API_BASE_URL || 'http://localhost:5000/api/v1';

export async function submitPromptToEngine(promptText) {
  try {
    const response = await fetch(`${API_BASE}/chat/query`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ prompt: promptText })
    });
    if (!response.ok) {
      const errorBody = await response.json().catch(() => ({}));
      throw new Error(errorBody.error || 'Network core bridge failure.');
    }
    return await response.json();
  } catch (error) {
    console.error('[Service API Error]:', error);
    return {
      success: false,
      error: error.message || 'Failed connecting to Ashu Codex AI cluster.'
    };
  }
}
