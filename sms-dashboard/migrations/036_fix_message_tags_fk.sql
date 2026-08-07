-- Migration 036: repair message_tags' dangling foreign key
--
-- message_tags declared:
--     FOREIGN KEY (message_id) REFERENCES "messages_old_backup"(id) ON DELETE CASCADE
-- and messages_old_backup does not exist.
--
-- How it got that way: an earlier refactor renamed messages -> messages_old_backup
-- and built a fresh messages table. SQLite rewrites foreign key references in OTHER
-- tables when a table is renamed, so message_tags silently started pointing at the
-- backup; the backup was then dropped, leaving the reference dangling.
--
-- Consequences, both verified on production:
--   * Every write to message_tags fails with "no such table: main.messages_old_backup".
--     The table holds 0 rows — server-side keyword tagging has never persisted
--     anything. (Highlighting still works: MessageHighlight.svelte matches in the
--     browser. The /api/messages/batch-tags path is what was dead.)
--   * The 12-month retention cron could never delete anything, because it clears a
--     message's tags in the same batch as the message.
--
-- Rebuild is the only option: SQLite cannot alter a foreign key in place.

-- Prerequisite. SQLite re-validates EVERY view when a table is dropped or renamed, so
-- a broken view anywhere blocks this migration. Two are broken, both left behind by
-- the 030/033 schema rebuild, which removed columns their definitions still reference:
--
--   sims_with_current_index  (migration 010)  -> no such column: s.current_modem_id
--   device_stats                              -> no such column: s.status
--
-- Both fail on any SELECT and neither is referenced anywhere in the server, client or
-- daemon; device_view is the only view actually in use (4 call sites). They are dead,
-- so they are dropped rather than repaired.
DROP VIEW IF EXISTS sims_with_current_index;
DROP VIEW IF EXISTS device_stats;

CREATE TABLE message_tags_rebuilt (
    message_id     TEXT NOT NULL,
    keyword_tag_id INTEGER NOT NULL,
    matched_text   TEXT NOT NULL,  -- The actual text that matched
    position       INTEGER NOT NULL, -- Starting position in message
    created_at     TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    PRIMARY KEY (message_id, keyword_tag_id, position),
    FOREIGN KEY (message_id) REFERENCES messages(id) ON DELETE CASCADE,
    FOREIGN KEY (keyword_tag_id) REFERENCES keyword_tags(id) ON DELETE CASCADE
);

-- Currently a no-op (0 rows), but written to carry data so the migration is correct
-- in any environment where tagging did manage to write.
INSERT INTO message_tags_rebuilt (message_id, keyword_tag_id, matched_text, position, created_at)
SELECT message_id, keyword_tag_id, matched_text, position, created_at FROM message_tags;

DROP TABLE message_tags;

-- Safe to rename: no other table references message_tags, so nothing else can have
-- its foreign keys rewritten the way message_tags itself did.
ALTER TABLE message_tags_rebuilt RENAME TO message_tags;

-- The old table carried two pairs of duplicate indexes (idx_message_tags_message /
-- idx_message_tags_message_id and the keyword equivalents) because both migration
-- 0010 and the runtime ensureKeywordTables() in server/api/keywords.js create them.
-- Only the canonical pair is recreated here.
CREATE INDEX IF NOT EXISTS idx_message_tags_message_id     ON message_tags(message_id);
CREATE INDEX IF NOT EXISTS idx_message_tags_keyword_tag_id ON message_tags(keyword_tag_id);
