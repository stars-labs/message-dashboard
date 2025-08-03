#!/usr/bin/env node

// Script to check for duplicate messages in the database

import { readFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// Read wrangler.toml to get database info
const wranglerConfig = readFileSync(join(__dirname, '../wrangler.toml'), 'utf8');
const dbMatch = wranglerConfig.match(/database_id\s*=\s*"([^"]+)"/);
const dbId = dbMatch ? dbMatch[1] : null;

if (!dbId) {
  console.error('Could not find database_id in wrangler.toml');
  process.exit(1);
}

// Query to check duplicate messages
const duplicateQuery = `
WITH message_groups AS (
  SELECT 
    phone_iccid,
    phone_number,
    content,
    COUNT(*) as duplicate_count,
    GROUP_CONCAT(id, ', ') as message_ids,
    MIN(timestamp) as first_occurrence,
    MAX(timestamp) as last_occurrence
  FROM messages
  WHERE phone_number IS NULL OR phone_number NOT LIKE '#%'
  GROUP BY phone_iccid, phone_number, content
  HAVING COUNT(*) > 1
)
SELECT * FROM message_groups
ORDER BY duplicate_count DESC
LIMIT 20;
`;

// Query to check total messages per ICCID
const iccidCountQuery = `
SELECT 
  phone_iccid,
  COUNT(*) as total_messages,
  COUNT(DISTINCT content) as unique_messages,
  COUNT(CASE WHEN type = 'received' THEN 1 END) as received_count,
  COUNT(CASE WHEN type = 'sent' THEN 1 END) as sent_count
FROM messages
WHERE phone_number IS NULL OR phone_number NOT LIKE '#%'
GROUP BY phone_iccid
ORDER BY total_messages DESC
LIMIT 10;
`;

// Query to get sample messages for the ICCID in question
const sampleQuery = `
SELECT 
  id,
  phone_iccid,
  phone_number,
  content,
  timestamp,
  type,
  recipient
FROM messages
WHERE phone_iccid = '89860117811039434858'
ORDER BY timestamp DESC
LIMIT 20;
`;

console.log('Checking for duplicate messages in the database...\n');

// Execute duplicate check
console.log('=== DUPLICATE MESSAGES ===');
console.log('Running query to find duplicate messages...');
console.log(`Command: npx wrangler d1 execute sms-dashboard --command="${duplicateQuery.replace(/\n/g, ' ')}" --remote\n`);

// Execute ICCID count check
console.log('\n=== MESSAGES PER ICCID ===');
console.log('Running query to count messages per ICCID...');
console.log(`Command: npx wrangler d1 execute sms-dashboard --command="${iccidCountQuery.replace(/\n/g, ' ')}" --remote\n`);

// Execute sample query
console.log('\n=== SAMPLE MESSAGES FOR ICCID 89860117811039434858 ===');
console.log('Running query to get sample messages...');
console.log(`Command: npx wrangler d1 execute sms-dashboard --command="${sampleQuery.replace(/\n/g, ' ')}" --remote\n`);

console.log('\nTo run these queries, execute the commands above in your terminal.');
console.log('\nAlternatively, you can run this one-liner to check everything:');
console.log(`
npx wrangler d1 execute sms-dashboard --command="WITH message_groups AS (SELECT phone_iccid, phone_number, content, COUNT(*) as duplicate_count FROM messages WHERE phone_number IS NULL OR phone_number NOT LIKE '#%' GROUP BY phone_iccid, phone_number, content HAVING COUNT(*) > 1) SELECT * FROM message_groups ORDER BY duplicate_count DESC LIMIT 10;" --remote && \\
npx wrangler d1 execute sms-dashboard --command="SELECT phone_iccid, COUNT(*) as total_messages, COUNT(DISTINCT content) as unique_messages FROM messages WHERE phone_iccid = '89860117811039434858' GROUP BY phone_iccid;" --remote && \\
npx wrangler d1 execute sms-dashboard --command="SELECT id, content, timestamp FROM messages WHERE phone_iccid = '89860117811039434858' ORDER BY timestamp DESC LIMIT 10;" --remote
`);