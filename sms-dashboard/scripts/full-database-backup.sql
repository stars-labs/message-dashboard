-- Full Database Backup Script for Normalization Migration
-- Generated: 2025-09-05 16:14:43
-- Purpose: Complete backup before normalization fixes

-- Export all tables with structure and data
-- This will be executed via wrangler d1 execute commands

-- First, let's get all table structures
SELECT 'Table: ' || name, sql FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name;

-- Export table counts for verification
SELECT 
    'messages' as table_name, COUNT(*) as record_count FROM messages
UNION ALL SELECT 
    'iccid_mappings' as table_name, COUNT(*) as record_count FROM iccid_mappings  
UNION ALL SELECT 
    'sims' as table_name, COUNT(*) as record_count FROM sims
UNION ALL SELECT 
    'modems' as table_name, COUNT(*) as record_count FROM modems
UNION ALL SELECT 
    'modem_state' as table_name, COUNT(*) as record_count FROM modem_state
UNION ALL SELECT 
    'daemon_health' as table_name, COUNT(*) as record_count FROM daemon_health
UNION ALL SELECT 
    'keyword_tags' as table_name, COUNT(*) as record_count FROM keyword_tags
UNION ALL SELECT 
    'message_tags' as table_name, COUNT(*) as record_count FROM message_tags
UNION ALL SELECT 
    'ai_insights' as table_name, COUNT(*) as record_count FROM ai_insights
UNION ALL SELECT 
    'ai_function_calls' as table_name, COUNT(*) as record_count FROM ai_function_calls
UNION ALL SELECT 
    'message_embeddings' as table_name, COUNT(*) as record_count FROM message_embeddings
ORDER BY table_name;

-- Export all indexes
SELECT 'Index: ' || name, sql FROM sqlite_master WHERE type='index' AND sql IS NOT NULL ORDER BY name;

-- Export all triggers
SELECT 'Trigger: ' || name, sql FROM sqlite_master WHERE type='trigger' ORDER BY name;

-- Export all views
SELECT 'View: ' || name, sql FROM sqlite_master WHERE type='view' ORDER BY name;