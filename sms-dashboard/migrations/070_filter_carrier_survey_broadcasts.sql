-- Migration 070: catch carrier marketing sent from campaign-suffixed shortcodes.
--
-- A 移动 satisfaction survey stayed visible in the dashboard because it arrived from
-- 100860011575 — the 10086 shortcode with a per-campaign suffix — and the sender rule
-- seeded in migration 035 was an exact match. server/utils/spam-filter.js now matches
-- a numeric pattern as a shortcode PREFIX, so every suffixed variant is covered by the
-- existing '10086'/'10010' rules without adding one rule per campaign.
--
-- This file adds the body-keyword rule for the survey wording, which catches the same
-- campaign should it ever arrive from an unrelated sender, and then requeues the rows
-- that the old exact match let through.

-- 满意度调研 blasts. '请您评价' is the stable part of the campaign name; the
-- surrounding text ("心级服务 让爱连接", the question count) varies per send.
INSERT OR IGNORE INTO filter_rules (rule_type, pattern, note) VALUES
    ('body_keyword', '请您评价', '运营商满意度调研群发'),
    ('body_keyword', '心级服务', '中国移动服务营销群发');

-- Requeue anything a carrier shortcode sent that is still showing. Setting
-- filter_status back to 'pending' keeps these rows VISIBLE (see
-- VISIBLE_FILTER_STATUSES) until POST /api/filters/reclassify sweeps them, so a
-- verification code cannot disappear as a side effect of this migration —
-- classifyMessage() re-checks hasVerificationCode() on every row it judges.
--
-- LIKE '%…%' deliberately over-selects, matching the sweep in spam-backfill.js:
-- the classifier has the final say, so 13910086 gets requeued and then judged clean.
UPDATE messages
SET filter_status = 'pending'
WHERE type = 'received'
  AND filter_status <> 'filtered'
  AND (
    phone_number LIKE '%10086%'
    OR phone_number LIKE '%10010%'
    OR instr(content, '请您评价') > 0
    OR instr(content, '心级服务') > 0
  );
