-- Migration 035: spam/marketing SMS filtering
--
-- The dashboard exists to surface verification codes, but carrier broadcasts and
-- marketing SMS drown them out. Rules live in filter_rules; the verdict for each
-- message is stored on the message itself so the list query stays an indexed WHERE.
--
-- The matching semantics are defined ONCE, in server/utils/spam-filter.js.
-- Nothing here decides anything — this file only provides storage and the seed rules.

-- One row per match rule.
--   rule_type 'body_keyword' -> substring match against messages.content
--   rule_type 'sender'       -> exact match against messages.phone_number
-- NOTE: received messages carry the SENDER's number in phone_number. The `sender`
-- column is never written by the daemon upload path, so it is deliberately unused.
CREATE TABLE IF NOT EXISTS filter_rules (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    rule_type  TEXT NOT NULL CHECK(rule_type IN ('body_keyword', 'sender')),
    pattern    TEXT NOT NULL,
    note       TEXT,
    is_active  INTEGER NOT NULL DEFAULT 1,
    -- Auth0 subject of whoever added the rule. Deliberately NOT a foreign key:
    -- there is no `users` table in this database (keyword_tags declares such an FK
    -- and it is unsatisfiable — inserting into it fails with "no such table: users").
    -- This is provenance metadata we never join on, so a constraint would only add
    -- a failure mode.
    created_by TEXT,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    UNIQUE(rule_type, pattern)
);

-- Classification result per message.
--   'pending'  = not judged yet; doubles as the resumable backfill cursor
--   'clean'    = shown in the default list
--   'filtered' = hidden unless the caller passes ?include_filtered=1
-- Existing rows default to 'pending' and are swept by POST /api/filters/reclassify.
ALTER TABLE messages ADD COLUMN filter_status TEXT NOT NULL DEFAULT 'pending';

-- Which rule hid this message. Kept for auditing false positives: when a real
-- verification code goes missing you can see exactly which rule ate it.
ALTER TABLE messages ADD COLUMN filter_rule_id INTEGER REFERENCES filter_rules(id) ON DELETE SET NULL;

-- The list query is: WHERE filter_status = 'clean' [AND phone_iccid = ?]
--                   ORDER BY timestamp DESC LIMIT ? OFFSET ?
-- so filter_status must lead and timestamp must be usable for the sort.
CREATE INDEX IF NOT EXISTS idx_messages_filter_ts       ON messages(filter_status, timestamp DESC);
CREATE INDEX IF NOT EXISTS idx_messages_iccid_filter_ts ON messages(phone_iccid, filter_status, timestamp DESC);
CREATE INDEX IF NOT EXISTS idx_filter_rules_active      ON filter_rules(is_active);

-- Seed rules.
--
-- The keyword patterns are deliberately SHORTER than the full offending sentences:
-- the real messages continue with variable text and full-width punctuation
-- (e.g. "中国海关提示，请勿携带…"), so matching only the stable prefix is more robust.
INSERT OR IGNORE INTO filter_rules (rule_type, pattern, note) VALUES
    ('body_keyword', '外交部领保中心',           '领保中心群发提醒'),
    ('body_keyword', '中国文化和旅游部温馨提示', '文旅部群发提醒'),
    ('body_keyword', '中国海关提示',             '海关群发提醒'),
    ('sender', '10086',  '中国移动群发'),
    ('sender', '10010',  '中国联通群发/营销'),
    ('sender', '101906', '联通助理漫游提醒'),
    -- 12306 also carries 购票成功 notices, which are arguably useful.
    -- Seeded because it is not a verification code; disable it in the UI to keep them.
    ('sender', '12306',  '铁路通知（如需保留购票通知可停用此规则）');
