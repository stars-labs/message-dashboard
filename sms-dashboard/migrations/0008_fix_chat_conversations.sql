-- Fix chat_conversations table by removing foreign key constraint
-- The system uses Auth0 for authentication, not a local users table

-- Drop existing tables in correct order (due to foreign key constraints)
DROP TABLE IF EXISTS chat_messages;
DROP TABLE IF EXISTS chat_conversations;

-- Recreate chat_conversations without foreign key constraint
CREATE TABLE chat_conversations (
    id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL,  -- Auth0 user ID (sub claim)
    started_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    last_message_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    message_count INTEGER DEFAULT 0,
    context JSON
);

-- Recreate chat_messages with proper foreign key
CREATE TABLE chat_messages (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    conversation_id TEXT NOT NULL,
    role TEXT CHECK(role IN ('user', 'assistant', 'system')) NOT NULL,
    content TEXT NOT NULL,
    function_calls JSON,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (conversation_id) REFERENCES chat_conversations(id) ON DELETE CASCADE
);

-- Create indexes for better performance
CREATE INDEX IF NOT EXISTS idx_chat_conversations_user_id ON chat_conversations(user_id);
CREATE INDEX IF NOT EXISTS idx_chat_conversations_last_message ON chat_conversations(last_message_at DESC);
CREATE INDEX IF NOT EXISTS idx_chat_messages_conversation ON chat_messages(conversation_id);
CREATE INDEX IF NOT EXISTS idx_chat_messages_created ON chat_messages(created_at DESC);