-- Migration 016: Clean up stale SIM assignments on multiple modems
-- Issue: ISSUES.md #2 — modems with multiple active SIMs from missing eviction logic
--
-- Root cause: Two bugs in control.js:
--   Bug 1: Reconciliation marks only status='connected' modems as pending, but
--           daemon reports status='active', so absent active modems are never cleared.
--   Bug 2: SIM upsert never evicts the previous SIM when a modem gets a new one.
--
-- Affected modems (as of 2026-03-06):
--   865827078940772 — offline since 2025-12-29 (75+ days), 6 stale SIMs
--   865827078942505 — active, current SIM is 8965012306052576256, 1 stale SIM

-- Step 1: Mark offline modem 865827078940772 as disconnected
UPDATE modems
SET status = 'disconnected',
    verification_status = 'absent',
    updated_at = CURRENT_TIMESTAMP
WHERE equipment_id = '865827078940772';

-- Step 2: Clear the 6 stale SIM assignments on offline modem 865827078940772
UPDATE sims
SET current_modem_id = NULL,
    status = 'inactive',
    updated_at = CURRENT_TIMESTAMP
WHERE current_modem_id = '865827078940772';

-- Step 3: Clear the 1 stale SIM on active modem 865827078942505
-- Current SIM (8965012306052576256) is kept; only the old one is cleared
UPDATE sims
SET current_modem_id = NULL,
    status = 'inactive',
    updated_at = CURRENT_TIMESTAMP
WHERE iccid = '89860124801222265285'
  AND current_modem_id = '865827078942505';

-- Step 4: Record migration
INSERT INTO schema_version (version, description, applied_at)
VALUES (16, 'Clean up stale SIM assignments on modems 865827078940772 and 865827078942505', CURRENT_TIMESTAMP);
