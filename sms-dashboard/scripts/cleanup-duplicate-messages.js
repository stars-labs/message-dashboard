#!/usr/bin/env node

/**
 * Script to clean up duplicate messages in the database
 * Run with: node scripts/cleanup-duplicate-messages.js
 */

console.log('🧹 SMS Dashboard - Duplicate Message Cleanup Script');
console.log('==================================================\n');

console.log('This script will help you identify and remove duplicate messages from the database.');
console.log('Duplicates are identified by: same content, source, phone_iccid, and timestamp within 1 minute.\n');

// First, let's identify duplicates
const identifyDuplicatesSQL = `
-- Identify duplicate messages (same content, source, phone_iccid within 1 minute window)
WITH message_groups AS (
  SELECT 
    id,
    phone_iccid,
    content,
    source,
    timestamp,
    datetime(timestamp) as dt,
    -- Group messages by content, source, phone_iccid and 1-minute time window
    content || '|' || COALESCE(source, 'unknown') || '|' || phone_iccid || '|' || 
    strftime('%Y-%m-%d %H:%M', datetime(timestamp)) as group_key,
    ROW_NUMBER() OVER (
      PARTITION BY 
        content,
        COALESCE(source, 'unknown'),
        phone_iccid,
        strftime('%Y-%m-%d %H:%M', datetime(timestamp))
      ORDER BY timestamp ASC
    ) as rn
  FROM messages
)
SELECT 
  phone_iccid,
  COUNT(*) as total_messages,
  COUNT(CASE WHEN rn = 1 THEN 1 END) as unique_messages,
  COUNT(CASE WHEN rn > 1 THEN 1 END) as duplicate_messages
FROM message_groups
GROUP BY phone_iccid
HAVING COUNT(CASE WHEN rn > 1 THEN 1 END) > 0
ORDER BY duplicate_messages DESC;
`;

console.log('📊 Step 1: Run this query to see duplicate statistics by phone:\n');
console.log('```sql');
console.log(identifyDuplicatesSQL);
console.log('```\n');

// Show specific duplicates for a phone
const showDuplicatesForPhoneSQL = `
-- Show duplicate messages for a specific phone (replace YOUR_ICCID)
WITH message_groups AS (
  SELECT 
    id,
    phone_iccid,
    content,
    source,
    timestamp,
    ROW_NUMBER() OVER (
      PARTITION BY 
        content,
        COALESCE(source, 'unknown'),
        phone_iccid,
        strftime('%Y-%m-%d %H:%M', datetime(timestamp))
      ORDER BY timestamp ASC
    ) as rn
  FROM messages
  WHERE phone_iccid = 'YOUR_ICCID'
)
SELECT 
  id,
  LEFT(content, 50) as content_preview,
  source,
  timestamp,
  rn,
  CASE WHEN rn = 1 THEN 'Keep' ELSE 'Delete' END as action
FROM message_groups
WHERE phone_iccid = 'YOUR_ICCID'
ORDER BY content, timestamp;
`;

console.log('📱 Step 2: Check duplicates for a specific phone:\n');
console.log('```sql');
console.log(showDuplicatesForPhoneSQL);
console.log('```\n');

// Delete duplicates (keep the first occurrence)
const deleteDuplicatesSQL = `
-- Delete duplicate messages (keeping the first occurrence of each unique message)
-- WARNING: This will permanently delete data! Make a backup first!

-- First, verify what will be deleted
WITH message_groups AS (
  SELECT 
    id,
    phone_iccid,
    content,
    source,
    timestamp,
    ROW_NUMBER() OVER (
      PARTITION BY 
        content,
        COALESCE(source, 'unknown'),
        phone_iccid,
        strftime('%Y-%m-%d %H:%M', datetime(timestamp))
      ORDER BY timestamp ASC
    ) as rn
  FROM messages
),
duplicates_to_delete AS (
  SELECT id
  FROM message_groups
  WHERE rn > 1
)
SELECT COUNT(*) as messages_to_delete
FROM duplicates_to_delete;

-- Then delete (uncomment to execute)
-- DELETE FROM messages
-- WHERE id IN (
--   WITH message_groups AS (
--     SELECT 
--       id,
--       phone_iccid,
--       content,
--       source,
--       timestamp,
--       ROW_NUMBER() OVER (
--         PARTITION BY 
--           content,
--           COALESCE(source, 'unknown'),
--           phone_iccid,
--           strftime('%Y-%m-%d %H:%M', datetime(timestamp))
--         ORDER BY timestamp ASC
--       ) as rn
--     FROM messages
--   )
--   SELECT id
--   FROM message_groups
--   WHERE rn > 1
-- );
`;

console.log('🗑️  Step 3: Delete duplicates (CAREFULLY!):\n');
console.log('```sql');
console.log(deleteDuplicatesSQL);
console.log('```\n');

// Verify cleanup
const verifyCleanupSQL = `
-- Verify cleanup results
SELECT 
  phone_iccid,
  COUNT(*) as total_messages
FROM messages
GROUP BY phone_iccid
ORDER BY total_messages DESC
LIMIT 20;
`;

console.log('✅ Step 4: Verify cleanup results:\n');
console.log('```sql');
console.log(verifyCleanupSQL);
console.log('```\n');

console.log('⚠️  IMPORTANT NOTES:');
console.log('1. Always backup your database before running DELETE operations');
console.log('2. Run the verification query first to see what will be deleted');
console.log('3. The script keeps the FIRST occurrence of each duplicate message');
console.log('4. Messages are considered duplicates if they have the same content, source, and phone_iccid within a 1-minute window\n');

console.log('To run these queries:');
console.log('1. For local testing: npx wrangler d1 execute sms-dashboard --local --command="QUERY_HERE"');
console.log('2. For production: npx wrangler d1 execute sms-dashboard --remote --command="QUERY_HERE"\n');

// Also provide a command to check specific ICCID
if (process.argv[2]) {
  const iccid = process.argv[2];
  console.log(`\n📱 Checking duplicates for ICCID: ${iccid}\n`);
  
  const checkSpecificSQL = showDuplicatesForPhoneSQL.replace(/YOUR_ICCID/g, iccid);
  console.log('Run this command:');
  console.log(`npx wrangler d1 execute sms-dashboard --remote --command="${checkSpecificSQL.replace(/\n/g, ' ').replace(/\s+/g, ' ')}"`);
}