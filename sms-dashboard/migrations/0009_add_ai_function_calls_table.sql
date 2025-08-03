-- Add missing AI function call logs table
CREATE TABLE IF NOT EXISTS ai_function_calls (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    conversation_id TEXT,
    function_name TEXT NOT NULL,
    parameters JSON,
    result JSON,
    success BOOLEAN DEFAULT TRUE,
    error_message TEXT,
    execution_time_ms INTEGER,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (conversation_id) REFERENCES chat_conversations(id) ON DELETE CASCADE
);

-- Create indexes for better performance
CREATE INDEX IF NOT EXISTS idx_ai_function_calls_conversation ON ai_function_calls(conversation_id);
CREATE INDEX IF NOT EXISTS idx_ai_function_calls_function ON ai_function_calls(function_name);
CREATE INDEX IF NOT EXISTS idx_ai_function_calls_created ON ai_function_calls(created_at);