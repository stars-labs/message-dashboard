-- Migration 017: Drop AI feature tables
-- AI Assistant feature removed. All /api/ai/* routes, handlers, and frontend
-- components (ChatAssistant, SemanticSearch, AIInsights) have been deleted.
-- Cloudflare AI and Vectorize bindings removed from wrangler.toml.

DROP TABLE IF EXISTS chat_messages;
DROP TABLE IF EXISTS ai_function_calls;
DROP TABLE IF EXISTS chat_conversations;
DROP TABLE IF EXISTS ai_insights;
DROP TABLE IF EXISTS message_embeddings;

INSERT INTO schema_version (version, description, applied_at)
VALUES (17, 'Drop AI tables: chat_conversations, chat_messages, ai_function_calls, ai_insights, message_embeddings', CURRENT_TIMESTAMP);
