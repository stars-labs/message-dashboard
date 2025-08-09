#!/usr/bin/env node

/**
 * Simple migration validation script
 * Run after migration to ensure data integrity
 */

import { execSync } from 'child_process';

console.log('🔍 Validating database migration...\n');

// Run validation SQL
try {
  const result = execSync(
    'npx wrangler d1 execute sms-dashboard --file=migrations/validate-migration.sql --remote',
    { encoding: 'utf-8' }
  );
  
  console.log(result);
  
  // Parse results to check for issues
  if (result.includes('orphaned_sims') && !result.includes('"orphaned_sims":0')) {
    console.error('⚠️  WARNING: Found orphaned SIMs without modems');
  }
  
  if (result.includes('duplicate')) {
    console.error('❌ ERROR: Found duplicate IDs in database');
    process.exit(1);
  }
  
  console.log('✅ Migration validation complete');
  
} catch (error) {
  console.error('❌ Migration validation failed:', error.message);
  console.log('\n📝 To rollback the migration, run:');
  console.log('npx wrangler d1 execute sms-dashboard --file=migrations/rollback-to-phones.sql --remote');
  process.exit(1);
}