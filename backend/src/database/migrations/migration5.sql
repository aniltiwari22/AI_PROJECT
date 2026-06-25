-- Ashu Codex AI DB Core Initialization Schema Script
CREATE TABLE IF NOT EXISTS interaction_histories (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    prompt_context TEXT NOT NULL,
    completion_context TEXT,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
);