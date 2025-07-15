#!/usr/bin/env node

// Script to fix null phone IDs in the database

const { execSync } = require('child_process');

console.log('Fixing null phone IDs in the database...\n');

// First, apply the migration to add missing columns
console.log('1. Applying migration to add missing columns...');
try {
  execSync('npx wrangler d1 execute sms-dashboard --file=database/migrations/add-missing-phone-columns.sql', {
    stdio: 'inherit'
  });
  console.log('✅ Migration applied successfully\n');
} catch (error) {
  console.error('❌ Error applying migration:', error.message);
  console.log('Continuing anyway...\n');
}

// Check for null IDs in local database
console.log('2. Checking for null IDs in local database...');
try {
  const result = execSync('npx wrangler d1 execute sms-dashboard --command "SELECT COUNT(*) as count FROM phones WHERE id IS NULL"', {
    encoding: 'utf-8'
  });
  console.log('Local database check:', result);
} catch (error) {
  console.error('Error checking local database:', error.message);
}

// Delete any rows with null IDs
console.log('\n3. Deleting rows with null IDs...');
try {
  execSync('npx wrangler d1 execute sms-dashboard --command "DELETE FROM phones WHERE id IS NULL"', {
    stdio: 'inherit'
  });
  console.log('✅ Null ID rows deleted\n');
} catch (error) {
  console.error('❌ Error deleting null ID rows:', error.message);
}

// Show current phone count
console.log('4. Current phone count:');
try {
  execSync('npx wrangler d1 execute sms-dashboard --command "SELECT COUNT(*) as total_phones FROM phones"', {
    stdio: 'inherit'
  });
} catch (error) {
  console.error('Error counting phones:', error.message);
}

console.log('\n✅ Script completed!');
console.log('\nNext steps:');
console.log('1. Deploy the updated control.js handler: npm run deploy');
console.log('2. Check the Zig daemon logs to see what data it\'s sending');
console.log('3. Monitor the control API logs to see if phones are being inserted correctly');