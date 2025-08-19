#!/usr/bin/env node

/**
 * Backup Verification Script
 * 
 * This script verifies that a backup can be successfully restored
 * Usage: node scripts/verify-backup.js [backup-folder]
 */

import { execSync } from 'child_process';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { dirname } from 'path';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// Configuration
const BACKUP_DIR = path.join(__dirname, '../backups');
const TEST_DB_NAME = `sms-dashboard-verify-${Date.now()}`;

// Colors for output
const colors = {
  reset: '\x1b[0m',
  bright: '\x1b[1m',
  red: '\x1b[31m',
  green: '\x1b[32m',
  yellow: '\x1b[33m',
  blue: '\x1b[34m',
  cyan: '\x1b[36m'
};

function log(message, color = '') {
  console.log(color + message + colors.reset);
}

function getLatestBackup() {
  if (!fs.existsSync(BACKUP_DIR)) {
    log('❌ No backups directory found', colors.red);
    process.exit(1);
  }
  
  const backups = fs.readdirSync(BACKUP_DIR)
    .filter(f => f.startsWith('backup-'))
    .sort()
    .reverse();
  
  if (backups.length === 0) {
    log('❌ No backup folders found', colors.red);
    process.exit(1);
  }
  
  return backups[0];
}

// Get backup folder from command line or use latest
const backupFolder = process.argv[2] || getLatestBackup();
const BACKUP_PATH = path.join(BACKUP_DIR, backupFolder);

if (!fs.existsSync(BACKUP_PATH)) {
  log(`❌ Backup folder not found: ${BACKUP_PATH}`, colors.red);
  process.exit(1);
}

log(`\n🔬 Backup Verification Tool`, colors.cyan);
log(`━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━`, colors.cyan);
log(`Backup: ${backupFolder}\n`, colors.bright);

// Load metadata
const metadataFile = path.join(BACKUP_PATH, 'metadata.json');
if (!fs.existsSync(metadataFile)) {
  log('❌ No metadata.json found in backup', colors.red);
  process.exit(1);
}

const metadata = JSON.parse(fs.readFileSync(metadataFile, 'utf-8'));

// Display backup information
log('📋 Backup Information:', colors.blue);
log(`  Timestamp: ${metadata.timestamp}`);
log(`  Database: ${metadata.database}`);
log(`  Location: ${metadata.location || 'unknown'}`);
log(`  Version: ${metadata.version}`);
log(`  Tables: ${Object.keys(metadata.tables).length}`);
log(`  Views: ${Object.keys(metadata.views || {}).length}`);
log(`  Triggers: ${Object.keys(metadata.triggers || {}).length}`);

let totalRows = 0;
for (const info of Object.values(metadata.tables)) {
  totalRows += info.rowCount;
}
log(`  Total rows: ${totalRows}\n`);

// Step 1: Check backup files
log('📁 Step 1: Checking backup files...', colors.blue);
const requiredFiles = ['metadata.json', 'backup.sql', 'complete-backup.json'];
const missingFiles = [];

for (const file of requiredFiles) {
  const filePath = path.join(BACKUP_PATH, file);
  if (fs.existsSync(filePath)) {
    const size = fs.statSync(filePath).size;
    log(`  ✅ ${file} (${(size / 1024 / 1024).toFixed(2)} MB)`, colors.green);
  } else {
    missingFiles.push(file);
    log(`  ❌ ${file} - MISSING`, colors.red);
  }
}

if (missingFiles.length > 0) {
  log('\n⚠️  Some backup files are missing', colors.yellow);
}

// Step 2: Validate SQL syntax
log('\n📝 Step 2: Validating SQL syntax...', colors.blue);
const sqlFile = path.join(BACKUP_PATH, 'backup.sql');
if (fs.existsSync(sqlFile)) {
  const sqlContent = fs.readFileSync(sqlFile, 'utf-8');
  const lines = sqlContent.split('\n');
  
  let tableCount = 0;
  let indexCount = 0;
  let viewCount = 0;
  let triggerCount = 0;
  let insertCount = 0;
  
  for (const line of lines) {
    if (line.startsWith('CREATE TABLE')) tableCount++;
    if (line.startsWith('CREATE INDEX')) indexCount++;
    if (line.startsWith('CREATE VIEW')) viewCount++;
    if (line.startsWith('CREATE TRIGGER')) triggerCount++;
    if (line.startsWith('INSERT INTO')) insertCount++;
  }
  
  log(`  Tables: ${tableCount}`, tableCount > 0 ? colors.green : colors.red);
  log(`  Indexes: ${indexCount}`, indexCount > 0 ? colors.green : colors.yellow);
  log(`  Views: ${viewCount}`, viewCount > 0 ? colors.green : colors.yellow);
  log(`  Triggers: ${triggerCount}`, triggerCount > 0 ? colors.green : colors.yellow);
  log(`  Insert statements: ${insertCount}`, insertCount > 0 ? colors.green : colors.yellow);
} else {
  log('  ❌ backup.sql not found', colors.red);
}

// Step 3: Test restore to local database
log('\n🔄 Step 3: Testing restore to local database...', colors.blue);
try {
  // Create local D1 database for testing
  log(`  Creating test database: ${TEST_DB_NAME}`);
  
  // Initialize local D1 database
  const wranglerConfig = `
name = "${TEST_DB_NAME}"
compatibility_date = "2023-05-18"

[[d1_databases]]
binding = "DB"
database_name = "${TEST_DB_NAME}"
database_id = "test-local-db"
`;
  
  const tempConfigPath = path.join(__dirname, 'temp-wrangler.toml');
  fs.writeFileSync(tempConfigPath, wranglerConfig);
  
  // Execute SQL file
  if (fs.existsSync(sqlFile)) {
    log('  Restoring database from backup.sql...');
    
    try {
      // Split SQL into smaller chunks to avoid command line limits
      const sqlContent = fs.readFileSync(sqlFile, 'utf-8');
      const statements = sqlContent.split(';\n').filter(s => s.trim());
      
      const batchSize = 100;
      const batches = Math.ceil(statements.length / batchSize);
      
      for (let i = 0; i < batches; i++) {
        const start = i * batchSize;
        const end = Math.min((i + 1) * batchSize, statements.length);
        const batch = statements.slice(start, end).join(';\n') + ';';
        
        const tempSqlFile = path.join(__dirname, `temp-batch-${i}.sql`);
        fs.writeFileSync(tempSqlFile, batch);
        
        process.stdout.write(`  Processing batch ${i + 1}/${batches}...`);
        
        execSync(
          `npx wrangler d1 execute ${TEST_DB_NAME} --local --file="${tempSqlFile}" --config="${tempConfigPath}"`,
          { stdio: 'pipe' }
        );
        
        fs.unlinkSync(tempSqlFile);
        process.stdout.write(' ✅\n');
      }
      
      log('  ✅ Database restored successfully', colors.green);
      
      // Step 4: Verify data integrity
      log('\n🔍 Step 4: Verifying data integrity...', colors.blue);
      
      let allGood = true;
      for (const [tableName, info] of Object.entries(metadata.tables)) {
        const countSQL = `SELECT COUNT(*) as count FROM ${tableName}`;
        
        try {
          const result = execSync(
            `npx wrangler d1 execute ${TEST_DB_NAME} --local --command="${countSQL}" --config="${tempConfigPath}"`,
            { encoding: 'utf-8', stdio: 'pipe' }
          );
          
          const match = result.match(/(\d+)/);
          const count = match ? parseInt(match[1]) : 0;
          
          if (count === info.rowCount) {
            log(`  ✅ ${tableName}: ${count} rows (matches)`, colors.green);
          } else {
            log(`  ❌ ${tableName}: ${count} rows (expected ${info.rowCount})`, colors.red);
            allGood = false;
          }
        } catch (e) {
          log(`  ❌ ${tableName}: Failed to verify`, colors.red);
          allGood = false;
        }
      }
      
      // Step 5: Check schema objects
      log('\n🏗️ Step 5: Checking schema objects...', colors.blue);
      
      // Check views
      if (metadata.views && Object.keys(metadata.views).length > 0) {
        const viewSQL = `SELECT name FROM sqlite_master WHERE type='view'`;
        try {
          const result = execSync(
            `npx wrangler d1 execute ${TEST_DB_NAME} --local --command="${viewSQL}" --config="${tempConfigPath}"`,
            { encoding: 'utf-8', stdio: 'pipe' }
          );
          
          const viewCount = (result.match(/\w+/g) || []).length - 1; // Subtract header
          log(`  Views: ${viewCount}/${Object.keys(metadata.views).length}`, 
            viewCount === Object.keys(metadata.views).length ? colors.green : colors.yellow);
        } catch (e) {
          log(`  Views: Failed to check`, colors.yellow);
        }
      }
      
      // Check triggers
      if (metadata.triggers && Object.keys(metadata.triggers).length > 0) {
        const triggerSQL = `SELECT name FROM sqlite_master WHERE type='trigger'`;
        try {
          const result = execSync(
            `npx wrangler d1 execute ${TEST_DB_NAME} --local --command="${triggerSQL}" --config="${tempConfigPath}"`,
            { encoding: 'utf-8', stdio: 'pipe' }
          );
          
          const triggerCount = (result.match(/\w+/g) || []).length - 1; // Subtract header
          log(`  Triggers: ${triggerCount}/${Object.keys(metadata.triggers).length}`, 
            triggerCount === Object.keys(metadata.triggers).length ? colors.green : colors.yellow);
        } catch (e) {
          log(`  Triggers: Failed to check`, colors.yellow);
        }
      }
      
      // Final verdict
      log('\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━', colors.cyan);
      if (allGood) {
        log('✅ VERIFICATION PASSED', colors.green + colors.bright);
        log('The backup is valid and can be restored successfully.', colors.green);
      } else {
        log('⚠️  VERIFICATION COMPLETED WITH WARNINGS', colors.yellow + colors.bright);
        log('The backup can be restored but some data may be missing.', colors.yellow);
      }
      
    } catch (error) {
      log(`  ❌ Restore failed: ${error.message}`, colors.red);
    }
    
  } else {
    log('  ❌ No backup.sql file found', colors.red);
  }
  
  // Cleanup
  if (fs.existsSync(tempConfigPath)) {
    fs.unlinkSync(tempConfigPath);
  }
  
} catch (error) {
  log(`\n❌ Verification failed: ${error.message}`, colors.red);
  process.exit(1);
}

log('\n📊 Verification Summary:', colors.cyan);
log(`  Backup Date: ${new Date(metadata.timestamp).toLocaleDateString()}`);
log(`  Tables: ${Object.keys(metadata.tables).length}`);
log(`  Total Rows: ${totalRows}`);
log(`  Backup Size: ${execSync(`du -sh ${BACKUP_PATH}`).toString().split('\t')[0]}`);

// Recommendations
log('\n💡 Recommendations:', colors.blue);
if (metadata.location === 'local') {
  log('  ⚠️  This backup was created from a LOCAL database', colors.yellow);
  log('     Consider creating a backup from the REMOTE database for production use');
}

if (totalRows > 100000) {
  log('  ℹ️  Large dataset detected (>100k rows)', colors.cyan);
  log('     Restore may take several minutes on production');
}

const backupAge = (Date.now() - new Date(metadata.timestamp).getTime()) / (1000 * 60 * 60 * 24);
if (backupAge > 30) {
  log(`  ⚠️  This backup is ${Math.floor(backupAge)} days old`, colors.yellow);
  log('     Consider creating a more recent backup');
}

log('');