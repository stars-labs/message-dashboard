#!/usr/bin/env node

// Diagnostic script to identify phone ID issues

const { execSync } = require('child_process');

console.log('🔍 Diagnosing phone ID issues...\n');

// Function to execute D1 command and parse result
function executeD1Command(command, remote = false) {
  try {
    const remoteFlag = remote ? '--remote' : '';
    const result = execSync(`npx wrangler d1 execute sms-dashboard ${remoteFlag} --command "${command}"`, {
      encoding: 'utf-8'
    });
    return JSON.parse(result);
  } catch (error) {
    return { error: error.message };
  }
}

// Check local database
console.log('📊 Local Database Analysis:');
console.log('─'.repeat(50));

const localChecks = [
  {
    name: 'Total phones',
    query: 'SELECT COUNT(*) as count FROM phones'
  },
  {
    name: 'Phones with NULL ID',
    query: 'SELECT COUNT(*) as count FROM phones WHERE id IS NULL'
  },
  {
    name: 'Phones with empty ID',
    query: "SELECT COUNT(*) as count FROM phones WHERE id = ''"
  },
  {
    name: 'Sample phone records',
    query: 'SELECT id, iccid, number, status FROM phones LIMIT 5'
  },
  {
    name: 'Distinct phone statuses',
    query: 'SELECT status, COUNT(*) as count FROM phones GROUP BY status'
  }
];

for (const check of localChecks) {
  console.log(`\n${check.name}:`);
  const result = executeD1Command(check.query);
  if (result.error) {
    console.log('❌ Error:', result.error);
  } else if (result[0] && result[0].results) {
    console.table(result[0].results);
  }
}

// Check for duplicate ICCIDs
console.log('\n🔍 Checking for duplicate ICCIDs:');
const duplicateCheck = executeD1Command(`
  SELECT iccid, COUNT(*) as count 
  FROM phones 
  WHERE iccid IS NOT NULL 
  GROUP BY iccid 
  HAVING COUNT(*) > 1
`);

if (duplicateCheck[0] && duplicateCheck[0].results && duplicateCheck[0].results.length > 0) {
  console.log('⚠️  Found duplicate ICCIDs:');
  console.table(duplicateCheck[0].results);
} else {
  console.log('✅ No duplicate ICCIDs found');
}

// Check table schema
console.log('\n📋 Table Schema:');
const schemaCheck = executeD1Command("PRAGMA table_info(phones)");
if (schemaCheck[0] && schemaCheck[0].results) {
  console.table(schemaCheck[0].results.map(col => ({
    name: col.name,
    type: col.type,
    nullable: col.notnull === 0 ? 'YES' : 'NO',
    default: col.dflt_value,
    pk: col.pk === 1 ? 'PRIMARY KEY' : ''
  })));
}

// Recommendations
console.log('\n💡 Recommendations:');
console.log('─'.repeat(50));

console.log('\n1. Apply the missing columns migration:');
console.log('   npx wrangler d1 execute sms-dashboard --file=database/migrations/add-missing-phone-columns.sql');

console.log('\n2. Clean up NULL ID entries:');
console.log('   npx wrangler d1 execute sms-dashboard --command "DELETE FROM phones WHERE id IS NULL"');

console.log('\n3. Deploy the fixed control handler:');
console.log('   npm run deploy');

console.log('\n4. Check Zig daemon logs to see what data is being sent:');
console.log('   - Ensure ICCID is being sent for each phone');
console.log('   - Verify the data format matches the expected schema');

console.log('\n5. Monitor the Worker logs after deployment:');
console.log('   npx wrangler tail sms-dashboard');

console.log('\n✅ Diagnostic complete!');