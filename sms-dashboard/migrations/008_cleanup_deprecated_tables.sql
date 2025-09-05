-- Migration 008: Cleanup deprecated and old backup tables
-- Date: 2025-09-05
-- Purpose: Remove deprecated tables after confirming migrations are stable
-- 
-- IMPORTANT: This permanently removes backup tables. Ensure you have external backups if needed!

-- Summary of tables to be removed:
-- 1. messages_old_backup (1001 rows) - Old messages table before normalization
-- 2. iccid_mappings_deprecated (32 rows) - Replaced by user_overrides in sims table

-- Create final verification queries before deletion
SELECT 'Checking data integrity before cleanup...' as status;

-- Verify new messages table has all data
SELECT 
  (SELECT COUNT(*) FROM messages) as current_messages_count,
  (SELECT COUNT(*) FROM messages_old_backup) as backup_messages_count,
  CASE 
    WHEN (SELECT COUNT(*) FROM messages) >= (SELECT COUNT(*) FROM messages_old_backup) 
    THEN '✅ Messages data verified' 
    ELSE '❌ WARNING: Message count mismatch!'
  END as verification_status;

-- Verify user overrides have been migrated
SELECT 
  (SELECT COUNT(*) FROM sims WHERE user_override_enabled = TRUE) as migrated_overrides,
  (SELECT COUNT(*) FROM iccid_mappings_deprecated WHERE is_active = 1) as deprecated_mappings,
  CASE 
    WHEN (SELECT COUNT(*) FROM sims WHERE user_override_enabled = TRUE) > 0
    THEN '✅ User overrides migrated' 
    ELSE '⚠️ No user overrides found'
  END as migration_status;

-- Drop deprecated tables
SELECT 'Dropping deprecated tables...' as status;

-- Drop the old messages backup table
DROP TABLE IF EXISTS messages_old_backup;
SELECT 'Dropped messages_old_backup table' as action;

-- Drop the deprecated iccid_mappings table
DROP TABLE IF EXISTS iccid_mappings_deprecated;
SELECT 'Dropped iccid_mappings_deprecated table' as action;

-- Check for any other temporary or backup tables
SELECT 'Checking for other temporary tables...' as status;
SELECT name as remaining_temp_tables
FROM sqlite_master 
WHERE (name LIKE '%backup%' OR name LIKE '%old%' OR name LIKE '%deprecated%' OR name LIKE '%temp%') 
  AND type='table';

-- Vacuum the database to reclaim space (optional - may take time on large databases)
-- Uncomment the next line if you want to reclaim space immediately
-- VACUUM;

-- Final database statistics
SELECT 'Database cleanup completed!' as status;
SELECT 
  COUNT(*) as total_tables,
  (SELECT COUNT(*) FROM sqlite_master WHERE type='view') as total_views,
  (SELECT COUNT(*) FROM sqlite_master WHERE type='index') as total_indexes,
  (SELECT COUNT(*) FROM sqlite_master WHERE type='trigger') as total_triggers
FROM sqlite_master 
WHERE type='table' 
  AND name NOT LIKE 'sqlite_%'
  AND name NOT LIKE '_cf_%';

SELECT '✅ Migration 008 completed successfully!' as final_status;
SELECT 'Old backup tables have been permanently removed' as info;