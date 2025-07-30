#!/usr/bin/env node

import { execSync } from 'child_process';

async function fixMessageContent() {
  console.log('Fetching messages with blob content...');
  
  // Get all messages with blob content
  const result = execSync(
    'npx wrangler d1 execute sms-dashboard --command "SELECT id, content FROM messages WHERE typeof(content) = \'blob\'" --remote --json',
    { encoding: 'utf8' }
  );
  
  const data = JSON.parse(result);
  const messages = data[0].results;
  
  console.log(`Found ${messages.length} messages with blob content to fix`);
  
  for (const message of messages) {
    try {
      // Convert byte array to UTF-8 string
      const buffer = Buffer.from(message.content);
      const text = buffer.toString('utf8');
      
      // Escape single quotes for SQL
      const escapedText = text.replace(/'/g, "''");
      
      // Update the message in the database
      const updateCmd = `UPDATE messages SET content = '${escapedText}' WHERE id = '${message.id}'`;
      
      console.log(`Updating message ${message.id}...`);
      execSync(
        `npx wrangler d1 execute sms-dashboard --command "${updateCmd}" --remote`,
        { encoding: 'utf8' }
      );
      
      console.log(`✓ Fixed message ${message.id}`);
    } catch (error) {
      console.error(`✗ Failed to fix message ${message.id}:`, error.message);
    }
  }
  
  console.log('\nVerifying fix...');
  const verifyResult = execSync(
    'npx wrangler d1 execute sms-dashboard --command "SELECT COUNT(*) as remaining FROM messages WHERE typeof(content) = \'blob\'" --remote --json',
    { encoding: 'utf8' }
  );
  
  const verifyData = JSON.parse(verifyResult);
  const remaining = verifyData[0].results[0].remaining;
  
  console.log(`\nComplete! ${remaining} blob messages remaining.`);
}

fixMessageContent().catch(console.error);