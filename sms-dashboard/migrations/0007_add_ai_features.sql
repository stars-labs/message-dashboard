-- AI Features Migration
-- Adds support for AI-powered verification code extraction, message classification,
-- semantic search embeddings, and chatbot conversation history

-- Add AI fields to messages table
ALTER TABLE messages ADD COLUMN ai_verification_code TEXT;
ALTER TABLE messages ADD COLUMN ai_confidence REAL;
ALTER TABLE messages ADD COLUMN ai_classification TEXT;
ALTER TABLE messages ADD COLUMN ai_processed_at TIMESTAMP;

-- AI insights table for detailed analysis
CREATE TABLE IF NOT EXISTS ai_insights (
    message_id TEXT PRIMARY KEY,
    classification TEXT,
    verification_code TEXT,
    confidence_score REAL,
    sender_category TEXT,
    language TEXT,
    is_spam BOOLEAN DEFAULT FALSE,
    urgency TEXT CHECK(urgency IN ('high', 'medium', 'low')),
    extracted_entities JSON,
    extracted_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (message_id) REFERENCES messages(id) ON DELETE CASCADE
);

-- Message embeddings for semantic search
CREATE TABLE IF NOT EXISTS message_embeddings (
    message_id TEXT PRIMARY KEY,
    embedding BLOB,
    model_version TEXT,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (message_id) REFERENCES messages(id) ON DELETE CASCADE
);

-- Chatbot conversation history
CREATE TABLE IF NOT EXISTS chat_conversations (
    id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL,
    started_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    last_message_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    message_count INTEGER DEFAULT 0,
    context JSON,
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
);

-- Chatbot messages
CREATE TABLE IF NOT EXISTS chat_messages (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    conversation_id TEXT NOT NULL,
    role TEXT CHECK(role IN ('user', 'assistant', 'system')) NOT NULL,
    content TEXT NOT NULL,
    function_calls JSON,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (conversation_id) REFERENCES chat_conversations(id) ON DELETE CASCADE
);

-- AI-generated templates
CREATE TABLE IF NOT EXISTS ai_templates (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    context TEXT,
    template_content TEXT NOT NULL,
    language TEXT DEFAULT 'en',
    tone TEXT CHECK(tone IN ('professional', 'casual', 'urgent', 'friendly')),
    category TEXT,
    usage_count INTEGER DEFAULT 0,
    created_by TEXT,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (created_by) REFERENCES users(id) ON DELETE SET NULL
);

-- AI function call logs for debugging and analytics
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
CREATE INDEX IF NOT EXISTS idx_ai_verification_code ON messages(ai_verification_code);
CREATE INDEX IF NOT EXISTS idx_ai_classification ON messages(ai_classification);
CREATE INDEX IF NOT EXISTS idx_ai_processed_at ON messages(ai_processed_at);
CREATE INDEX IF NOT EXISTS idx_ai_insights_classification ON ai_insights(classification);
CREATE INDEX IF NOT EXISTS idx_ai_insights_sender ON ai_insights(sender_category);
CREATE INDEX IF NOT EXISTS idx_ai_insights_spam ON ai_insights(is_spam);
CREATE INDEX IF NOT EXISTS idx_chat_conversations_user ON chat_conversations(user_id);
CREATE INDEX IF NOT EXISTS idx_chat_messages_conversation ON chat_messages(conversation_id);
CREATE INDEX IF NOT EXISTS idx_chat_messages_created ON chat_messages(created_at);
CREATE INDEX IF NOT EXISTS idx_ai_templates_category ON ai_templates(category);
CREATE INDEX IF NOT EXISTS idx_ai_function_calls_conversation ON ai_function_calls(conversation_id);
CREATE INDEX IF NOT EXISTS idx_ai_function_calls_function ON ai_function_calls(function_name);

-- Insert default AI templates
INSERT OR IGNORE INTO ai_templates (name, context, template_content, language, tone, category) VALUES
    ('Bank Verification Response', 'When receiving bank verification codes', 'Code received. Thank you.', 'en', 'professional', 'verification'),
    ('Delivery Confirmation', 'For package delivery notifications', 'Thanks for the update. Package tracking noted.', 'en', 'casual', 'delivery'),
    ('Spam Report', 'For reporting spam messages', 'This appears to be spam. Please remove me from your list.', 'en', 'professional', 'spam'),
    ('验证码确认', 'For Chinese verification codes', '验证码已收到，谢谢。', 'zh', 'professional', 'verification'),
    ('Test Message', 'For testing phone functionality', 'Test message sent at {timestamp}. Please confirm receipt.', 'en', 'professional', 'testing');