#!/usr/bin/env node

import { execSync } from 'child_process';

console.log('Cleaning up null phone entries from database...');

try {
  // First, let's see how many null entries we have
  const countCmd = `npx wrangler d1 execute sms-dashboard --command "SELECT COUNT(*) as count FROM phones WHERE id IS NULL" --json`;
  const countResult = JSON.parse(execSync(countCmd, { encoding: 'utf-8' }));
  console.log(`Found ${countResult[0].results[0].count} phones with null IDs`);

  // Delete all phones with null IDs
  const deleteCmd = `npx wrangler d1 execute sms-dashboard --command "DELETE FROM phones WHERE id IS NULL"`;
  execSync(deleteCmd, { stdio: 'inherit' });
  
  console.log('✅ Deleted all phones with null IDs');
  
  // Show remaining phones
  const remainingCmd = `npx wrangler d1 execute sms-dashboard --command "SELECT id, iccid, number, status FROM phones LIMIT 10" --json`;
  const remaining = JSON.parse(execSync(remainingCmd, { encoding: 'utf-8' }));
  
  console.log('\nRemaining phones (first 10):');
  console.table(remaining[0].results);
  
} catch (error) {
  console.error('Error cleaning up database:', error.message);
  process.exit(1);
}