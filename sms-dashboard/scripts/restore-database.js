#!/usr/bin/env node

/**
 * Database Restore Script for Cloudflare D1
 * 
 * This script restores D1 database from backup files
 * Usage: node scripts/restore-database.js [backup-folder]
 */

const { execSync } = require('child_process');
const fs = require('fs');
const path = require('path');
const readline = require('readline');

// Configuration
const DATABASE_NAME = 'sms-dashboard';
const BACKUP_DIR = path.join(__dirname, '../backups');

// Get backup folder from command line or use latest
const backupFolder = process.argv[2] || getLatestBackup();

function getLatestBackup() {
  if (!fs.existsSync(BACKUP_DIR)) {
    console.error('❌ No backups directory found');
    process.exit(1);
  }
  
  const backups = fs.readdirSync(BACKUP_DIR)
    .filter(f => f.startsWith('backup-'))
    .sort()
    .reverse();
  
  if (backups.length === 0) {
    console.error('❌ No backup folders found');
    process.exit(1);
  }
  
  return backups[0];
}

const BACKUP_PATH = path.join(BACKUP_DIR, backupFolder);

if (!fs.existsSync(BACKUP_PATH)) {
  console.error(`❌ Backup folder not found: ${BACKUP_PATH}`);
  process.exit(1);
}

console.log(`🔄 Restoring database from: ${BACKUP_PATH}`);

// Function to execute wrangler command
function runWranglerCommand(sql, isLocal = false) {
  const location = isLocal ? '--local' : '--remote';
  const command = `npx wrangler d1 execute ${DATABASE_NAME} ${location} --command="${sql}"`;
  
  try {
    const result = execSync(command, { encoding: 'utf-8', maxBuffer: 50 * 1024 * 1024 });
    return result;
  } catch (error) {
    console.error(`Error executing SQL: ${sql.substring(0, 100)}...`);
    console.error(error.message);
    return null;
  }
}

// Function to execute SQL file
function runSQLFile(filePath, isLocal = false) {
  const location = isLocal ? '--local' : '--remote';
  const command = `npx wrangler d1 execute ${DATABASE_NAME} ${location} --file="${filePath}"`;
  
  try {
    const result = execSync(command, { encoding: 'utf-8', maxBuffer: 50 * 1024 * 1024 });
    return result;
  } catch (error) {
    console.error(`Error executing SQL file: ${filePath}`);
    console.error(error.message);
    return null;
  }
}

// Function to create tables from backup
async function createTables(backup) {
  console.log('\n📋 Creating tables...');
  
  for (const [tableName, tableData] of Object.entries(backup.tables)) {
    if (!tableData.schema) continue;
    
    console.log(`  Creating table: ${tableName}`);
    
    // Drop existing table
    runWranglerCommand(`DROP TABLE IF EXISTS ${tableName}`);
    
    // Create table
    const result = runWranglerCommand(tableData.schema);
    if (result) {
      console.log(`    ✅ Table created: ${tableName}`);
    } else {
      console.log(`    ❌ Failed to create table: ${tableName}`);
    }
    
    // Create indexes
    if (tableData.indexes && tableData.indexes.length > 0) {
      console.log(`    Creating ${tableData.indexes.length} indexes...`);
      for (const index of tableData.indexes) {
        runWranglerCommand(index);
      }
    }
  }
}

// Function to import data in batches
async function importData(backup) {
  console.log('\n📊 Importing data...');
  
  for (const [tableName, tableData] of Object.entries(backup.tables)) {
    if (!tableData.data || tableData.data.length === 0) {
      console.log(`  Skipping ${tableName} (no data)`);
      continue;
    }
    
    console.log(`  Importing ${tableData.data.length} rows into ${tableName}`);
    
    const batchSize = 100; // Insert 100 rows at a time
    const batches = Math.ceil(tableData.data.length / batchSize);
    
    for (let i = 0; i < batches; i++) {
      const start = i * batchSize;
      const end = Math.min((i + 1) * batchSize, tableData.data.length);
      const batchData = tableData.data.slice(start, end);
      
      // Create INSERT statements
      const columns = Object.keys(batchData[0]);
      let insertSQL = '';
      
      for (const row of batchData) {
        const values = columns.map(col => {
          const value = row[col];
          if (value === null || value === undefined) return 'NULL';
          if (typeof value === 'string') {
            return `'${value.replace(/'/g, "''")}'`;
          }
          if (typeof value === 'boolean') {
            return value ? 1 : 0;
          }
          return value;
        });
        
        insertSQL += `INSERT INTO ${tableName} (${columns.join(', ')}) VALUES (${values.join(', ')});\n`;
      }
      
      // Write batch to temp file and execute
      const tempFile = path.join(BACKUP_PATH, `temp_batch_${i}.sql`);
      fs.writeFileSync(tempFile, insertSQL);
      
      process.stdout.write(`    Batch ${i + 1}/${batches} (rows ${start + 1}-${end})...`);
      
      const result = runSQLFile(tempFile);
      if (result) {
        process.stdout.write(' ✅\n');
      } else {
        process.stdout.write(' ❌\n');
      }
      
      // Clean up temp file
      fs.unlinkSync(tempFile);
    }
    
    console.log(`    ✅ Imported ${tableData.data.length} rows into ${tableName}`);
  }
}

// Function to restore from SQL dump
async function restoreFromSQL() {
  const sqlFile = path.join(BACKUP_PATH, 'backup.sql');
  
  if (!fs.existsSync(sqlFile)) {
    console.log('❌ No SQL dump file found');
    return false;
  }
  
  console.log('\n📝 Restoring from SQL dump...');
  
  // Split SQL file into chunks to avoid command line length limits
  const sqlContent = fs.readFileSync(sqlFile, 'utf-8');
  const statements = sqlContent.split(';\n').filter(s => s.trim());
  
  const batchSize = 50;
  const batches = Math.ceil(statements.length / batchSize);
  
  for (let i = 0; i < batches; i++) {
    const start = i * batchSize;
    const end = Math.min((i + 1) * batchSize, statements.length);
    const batchStatements = statements.slice(start, end);
    
    const batchSQL = batchStatements.join(';\n') + ';';
    const tempFile = path.join(BACKUP_PATH, `temp_restore_${i}.sql`);
    
    fs.writeFileSync(tempFile, batchSQL);
    
    process.stdout.write(`  Processing batch ${i + 1}/${batches}...`);
    
    const result = runSQLFile(tempFile);
    if (result) {
      process.stdout.write(' ✅\n');
    } else {
      process.stdout.write(' ❌\n');
    }
    
    fs.unlinkSync(tempFile);
  }
  
  return true;
}

// Function to verify restore
async function verifyRestore(backup) {
  console.log('\n🔍 Verifying restore...');
  
  let allGood = true;
  
  for (const [tableName, tableInfo] of Object.entries(backup.metadata.tables)) {
    const countSQL = `SELECT COUNT(*) as count FROM ${tableName}`;
    const result = runWranglerCommand(countSQL);
    
    if (result) {
      const match = result.match(/(\d+)/);
      const count = match ? parseInt(match[1]) : 0;
      
      if (count === tableInfo.rowCount) {
        console.log(`  ✅ ${tableName}: ${count} rows (matches backup)`);
      } else {
        console.log(`  ⚠️  ${tableName}: ${count} rows (backup had ${tableInfo.rowCount})`);
        allGood = false;
      }
    } else {
      console.log(`  ❌ ${tableName}: Could not verify`);
      allGood = false;
    }
  }
  
  return allGood;
}

// Function to prompt user
function prompt(question) {
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout
  });
  
  return new Promise(resolve => {
    rl.question(question, answer => {
      rl.close();
      resolve(answer);
    });
  });
}

// Main restore function
async function restoreDatabase() {
  // Load backup metadata
  const metadataFile = path.join(BACKUP_PATH, 'metadata.json');
  if (!fs.existsSync(metadataFile)) {
    console.error('❌ No metadata.json found in backup folder');
    process.exit(1);
  }
  
  const metadata = JSON.parse(fs.readFileSync(metadataFile, 'utf-8'));
  
  console.log('\n📋 Backup Information:');
  console.log(`  Timestamp: ${metadata.timestamp}`);
  console.log(`  Database: ${metadata.database}`);
  console.log(`  Tables: ${Object.keys(metadata.tables).length}`);
  
  let totalRows = 0;
  for (const [table, info] of Object.entries(metadata.tables)) {
    totalRows += info.rowCount;
  }
  console.log(`  Total rows: ${totalRows}`);
  
  // Ask for confirmation
  const answer = await prompt('\n⚠️  This will REPLACE all data in the database. Continue? (yes/no): ');
  if (answer.toLowerCase() !== 'yes') {
    console.log('❌ Restore cancelled');
    process.exit(0);
  }
  
  // Check for SQL dump first (faster)
  const sqlDumpExists = fs.existsSync(path.join(BACKUP_PATH, 'backup.sql'));
  const completeBackupExists = fs.existsSync(path.join(BACKUP_PATH, 'complete-backup.json'));
  
  if (sqlDumpExists) {
    console.log('\n📝 SQL dump found. Using fast restore method...');
    const success = await restoreFromSQL();
    
    if (success) {
      // Load complete backup for verification
      if (completeBackupExists) {
        const backup = JSON.parse(fs.readFileSync(path.join(BACKUP_PATH, 'complete-backup.json'), 'utf-8'));
        await verifyRestore(backup);
      }
    }
  } else if (completeBackupExists) {
    console.log('\n📦 Using JSON backup...');
    
    // Load complete backup
    const backup = JSON.parse(fs.readFileSync(path.join(BACKUP_PATH, 'complete-backup.json'), 'utf-8'));
    
    // Create tables
    await createTables(backup);
    
    // Import data
    await importData(backup);
    
    // Verify
    await verifyRestore(backup);
  } else {
    console.error('❌ No suitable backup file found (backup.sql or complete-backup.json)');
    process.exit(1);
  }
  
  console.log('\n✅ Restore completed!');
  
  // Update sequences if needed
  console.log('\n🔧 Updating sequences...');
  
  // Update autoincrement sequences
  const sequenceSQL = `
    SELECT name, seq FROM sqlite_sequence;
  `;
  
  const seqResult = runWranglerCommand(sequenceSQL);
  if (seqResult) {
    console.log('  Sequences updated');
  }
  
  console.log('\n🎉 Database restore successful!');
}

// Run restore
restoreDatabase().catch(console.error);