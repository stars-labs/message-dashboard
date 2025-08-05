-- Add keyword-tag mapping feature
-- This migration adds tables for keyword highlighting and tagging

-- Keyword tags table
CREATE TABLE IF NOT EXISTS keyword_tags (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    keyword TEXT NOT NULL,
    tag TEXT NOT NULL,
    color TEXT DEFAULT '#3B82F6', -- Default blue color
    priority INTEGER DEFAULT 0, -- Higher priority keywords take precedence
    is_active BOOLEAN DEFAULT TRUE,
    case_sensitive BOOLEAN DEFAULT FALSE,
    whole_word BOOLEAN DEFAULT FALSE, -- Match whole words only
    created_by TEXT,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- Message tags table (many-to-many relationship)
CREATE TABLE IF NOT EXISTS message_tags (
    message_id TEXT NOT NULL,
    keyword_tag_id INTEGER NOT NULL,
    matched_text TEXT NOT NULL, -- The actual text that matched
    position INTEGER NOT NULL, -- Starting position in message
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    PRIMARY KEY (message_id, keyword_tag_id, position),
    FOREIGN KEY (message_id) REFERENCES messages(id) ON DELETE CASCADE,
    FOREIGN KEY (keyword_tag_id) REFERENCES keyword_tags(id) ON DELETE CASCADE
);

-- Indexes for performance
CREATE INDEX IF NOT EXISTS idx_keyword_tags_keyword ON keyword_tags(keyword);
CREATE INDEX IF NOT EXISTS idx_keyword_tags_active ON keyword_tags(is_active);
CREATE INDEX IF NOT EXISTS idx_keyword_tags_priority ON keyword_tags(priority DESC);
CREATE INDEX IF NOT EXISTS idx_message_tags_message_id ON message_tags(message_id);
CREATE INDEX IF NOT EXISTS idx_message_tags_keyword_tag_id ON message_tags(keyword_tag_id);