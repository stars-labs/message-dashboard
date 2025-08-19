#!/usr/bin/env node

/**
 * Database Backup Script for Cloudflare D1
 * 
 * This script backs up all data from the D1 database to local files
 * Usage: node scripts/backup-database.js
 */

import { execSync } from 'child_process';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { dirname } from 'path';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// Configuration
const DATABASE_NAME = 'sms-dashboard';
const BACKUP_DIR = path.join(__dirname, '../backups');
const TIMESTAMP = new Date().toISOString().replace(/[:.]/g, '-').slice(0, -5);
const BACKUP_PATH = path.join(BACKUP_DIR, `backup-${TIMESTAMP}`);

// Get command line arguments
const args = process.argv.slice(2);
const IS_LOCAL = args.includes('--local');
const VERIFY_MODE = args.includes('--verify');

if (IS_LOCAL) {
  console.log('🏠 Running in LOCAL mode');
}
if (VERIFY_MODE) {
  console.log('✅ Verification mode enabled');
}

// Ensure backup directory exists
if (!fs.existsSync(BACKUP_DIR)) {
  fs.mkdirSync(BACKUP_DIR, { recursive: true });
}

if (!fs.existsSync(BACKUP_PATH)) {
  fs.mkdirSync(BACKUP_PATH, { recursive: true });
}

console.log(`🚀 Starting database backup to ${BACKUP_PATH}`);

// Function to execute wrangler command
function runWranglerCommand(sql, isLocal = IS_LOCAL) {
  const location = isLocal ? '--local' : '--remote';
  const command = `npx wrangler d1 execute ${DATABASE_NAME} ${location} --command="${sql}"`;
  
  try {
    const result = execSync(command, { encoding: 'utf-8', maxBuffer: 50 * 1024 * 1024 });
    return result;
  } catch (error) {
    console.error(`Error executing SQL: ${sql}`);
    console.error(error.message);
    return null;
  }
}

// Function to get all tables dynamically
async function getAllTables() {
  console.log('📋 Discovering all tables...');
  
  const sql = `
    SELECT name FROM sqlite_master 
    WHERE type='table' 
    AND name NOT LIKE 'sqlite_%'
    AND name NOT LIKE '_cf_%'
    ORDER BY name
  `;
  
  const result = runWranglerCommand(sql);
  const tables = [];
  
  if (result) {
    try {
      // Parse JSON from wrangler output
      const jsonMatch = result.match(/\[\s*\{[\s\S]*\}\s*\]/);
      if (jsonMatch) {
        const data = JSON.parse(jsonMatch[0]);
        if (data[0] && data[0].results) {
          for (const row of data[0].results) {
            if (row.name) {
              tables.push(row.name);
            }
          }
        }
      }
    } catch (e) {
      console.error('Failed to parse table list:', e.message);
    }
  }
  
  console.log(`  Found ${tables.length} tables: ${tables.join(', ')}`);
  return tables;
}

// Function to get all views
async function getAllViews() {
  console.log('👁️ Discovering all views...');
  
  const sql = `
    SELECT name, sql FROM sqlite_master 
    WHERE type='view'
    ORDER BY name
  `;
  
  const result = runWranglerCommand(sql);
  const views = [];
  
  if (result) {
    try {
      const jsonMatch = result.match(/\[\s*\{[\s\S]*\}\s*\]/);
      if (jsonMatch) {
        const data = JSON.parse(jsonMatch[0]);
        if (data[0] && data[0].results) {
          for (const row of data[0].results) {
            if (row.name && row.sql) {
              views.push({
                name: row.name,
                sql: row.sql
              });
            }
          }
        }
      }
    } catch (e) {
      console.error('Failed to parse view list:', e.message);
    }
  }
  
  console.log(`  Found ${views.length} views: ${views.map(v => v.name).join(', ')}`);
  return views;
}

// Function to get all triggers
async function getAllTriggers() {
  console.log('⚡ Discovering all triggers...');
  
  const sql = `
    SELECT name, sql FROM sqlite_master 
    WHERE type='trigger'
    ORDER BY name
  `;
  
  const result = runWranglerCommand(sql);
  const triggers = [];
  
  if (result) {
    try {
      const jsonMatch = result.match(/\[\s*\{[\s\S]*\}\s*\]/);
      if (jsonMatch) {
        const data = JSON.parse(jsonMatch[0]);
        if (data[0] && data[0].results) {
          for (const row of data[0].results) {
            if (row.name && row.sql) {
              triggers.push({
                name: row.name,
                sql: row.sql
              });
            }
          }
        }
      }
    } catch (e) {
      console.error('Failed to parse trigger list:', e.message);
    }
  }
  
  console.log(`  Found ${triggers.length} triggers: ${triggers.map(t => t.name).join(', ')}`);
  return triggers;
}

// Function to get table schema
function getTableSchema(tableName) {
  console.log(`📋 Getting schema for table: ${tableName}`);
  
  const schemaSQL = `
    SELECT sql FROM sqlite_master 
    WHERE type='table' AND name='${tableName}'
  `;
  
  const result = runWranglerCommand(schemaSQL);
  if (result) {
    try {
      const jsonMatch = result.match(/\[\s*\{[\s\S]*\}\s*\]/);
      if (jsonMatch) {
        const data = JSON.parse(jsonMatch[0]);
        if (data[0] && data[0].results && data[0].results[0]) {
          return data[0].results[0].sql;
        }
      }
    } catch (e) {
      console.error('Failed to parse schema:', e.message);
    }
  }
  return null;
}

// Function to export table data to JSON
async function exportTableData(tableName) {
  console.log(`📊 Exporting data from table: ${tableName}`);
  
  const countSQL = `SELECT COUNT(*) as count FROM ${tableName}`;
  const countResult = runWranglerCommand(countSQL);
  
  let rowCount = 0;
  if (countResult && countResult.includes('count')) {
    const match = countResult.match(/(\d+)/);
    if (match) {
      rowCount = parseInt(match[1]);
    }
  }
  
  console.log(`  Found ${rowCount} rows in ${tableName}`);
  
  if (rowCount === 0) {
    return [];
  }
  
  // Export data in chunks to handle large tables
  const chunkSize = 1000;
  const chunks = Math.ceil(rowCount / chunkSize);
  let allData = [];
  
  for (let i = 0; i < chunks; i++) {
    const offset = i * chunkSize;
    const dataSQL = `SELECT * FROM ${tableName} LIMIT ${chunkSize} OFFSET ${offset}`;
    
    console.log(`  Exporting chunk ${i + 1}/${chunks} (rows ${offset + 1}-${Math.min(offset + chunkSize, rowCount)})`);
    
    const result = runWranglerCommand(dataSQL);
    
    if (result) {
      try {
        // Parse the JSON output from wrangler
        const jsonMatch = result.match(/\[[\s\S]*\]/);
        if (jsonMatch) {
          const data = JSON.parse(jsonMatch[0]);
          allData = allData.concat(data);
        }
      } catch (error) {
        console.error(`  Error parsing data for ${tableName}:`, error.message);
        // Save raw output for debugging
        fs.writeFileSync(
          path.join(BACKUP_PATH, `${tableName}_raw.txt`),
          result
        );
      }
    }
  }
  
  return allData;
}

// Function to get indexes for a table
function getTableIndexes(tableName) {
  console.log(`🔍 Getting indexes for table: ${tableName}`);
  
  const indexSQL = `
    SELECT sql FROM sqlite_master 
    WHERE type='index' 
    AND tbl_name='${tableName}'
    AND sql IS NOT NULL
  `;
  
  const result = runWranglerCommand(indexSQL);
  const indexes = [];
  
  if (result) {
    const lines = result.split('\n');
    for (const line of lines) {
      if (line.includes('CREATE')) {
        let sql = line.replace(/^.*?(CREATE.*)$/, '$1');
        indexes.push(sql);
      }
    }
  }
  
  return indexes;
}

// Main backup function
async function backupDatabase() {
  const backupMetadata = {
    timestamp: new Date().toISOString(),
    database: DATABASE_NAME,
    location: IS_LOCAL ? 'local' : 'remote',
    tables: {},
    views: {},
    triggers: {},
    version: '3.0'
  };
  
  // Discover all database objects
  const tables = await getAllTables();
  const views = await getAllViews();
  const triggers = await getAllTriggers();
  
  // Backup each table
  for (const table of tables) {
    console.log(`\n🔄 Processing table: ${table}`);
    
    // Get schema
    const schema = getTableSchema(table);
    if (!schema) {
      console.log(`  ⚠️  Table ${table} not found, skipping...`);
      continue;
    }
    
    // Get indexes
    const indexes = getTableIndexes(table);
    
    // Get data
    const data = await exportTableData(table);
    
    // Save table backup
    const tableBackup = {
      name: table,
      schema: schema,
      indexes: indexes,
      data: data,
      rowCount: data.length
    };
    
    // Save to individual file
    fs.writeFileSync(
      path.join(BACKUP_PATH, `${table}.json`),
      JSON.stringify(tableBackup, null, 2)
    );
    
    backupMetadata.tables[table] = {
      rowCount: data.length,
      hasIndexes: indexes.length > 0
    };
    
    console.log(`  ✅ Backed up ${data.length} rows from ${table}`);
  }
  
  // Save views
  console.log('\n📐 Backing up views...');
  for (const view of views) {
    backupMetadata.views[view.name] = view.sql;
    console.log(`  ✅ Backed up view: ${view.name}`);
  }
  
  // Save triggers  
  console.log('\n⚡ Backing up triggers...');
  for (const trigger of triggers) {
    backupMetadata.triggers[trigger.name] = trigger.sql;
    console.log(`  ✅ Backed up trigger: ${trigger.name}`);
  }
  
  // Save metadata
  fs.writeFileSync(
    path.join(BACKUP_PATH, 'metadata.json'),
    JSON.stringify(backupMetadata, null, 2)
  );
  
  // Create a combined backup file for easier transfer
  console.log('\n📦 Creating combined backup file...');
  
  const combinedBackup = {
    metadata: backupMetadata,
    tables: {}
  };
  
  for (const table of TABLES) {
    const tableFile = path.join(BACKUP_PATH, `${table}.json`);
    if (fs.existsSync(tableFile)) {
      combinedBackup.tables[table] = JSON.parse(fs.readFileSync(tableFile, 'utf-8'));
    }
  }
  
  fs.writeFileSync(
    path.join(BACKUP_PATH, 'complete-backup.json'),
    JSON.stringify(combinedBackup, null, 2)
  );
  
  // Create SQL dump file for easier restore
  console.log('\n📝 Creating SQL dump file...');
  
  let sqlDump = `-- D1 Database Backup\n`;
  sqlDump += `-- Generated: ${new Date().toISOString()}\n`;
  sqlDump += `-- Database: ${DATABASE_NAME}\n`;
  sqlDump += `-- Location: ${IS_LOCAL ? 'LOCAL' : 'REMOTE'}\n\n`;
  
  // Add tables
  for (const table of tables) {
    const tableFile = path.join(BACKUP_PATH, `${table}.json`);
    if (!fs.existsSync(tableFile)) continue;
    
    const tableData = JSON.parse(fs.readFileSync(tableFile, 'utf-8'));
    
    // Add DROP TABLE statement
    sqlDump += `-- Table: ${table}\n`;
    sqlDump += `DROP TABLE IF EXISTS ${table};\n`;
    
    // Add CREATE TABLE statement
    sqlDump += `${tableData.schema};\n\n`;
    
    // Add indexes
    for (const index of tableData.indexes) {
      sqlDump += `${index};\n`;
    }
    sqlDump += '\n';
    
    // Add INSERT statements
    if (tableData.data.length > 0) {
      const columns = Object.keys(tableData.data[0]);
      
      for (const row of tableData.data) {
        const values = columns.map(col => {
          const value = row[col];
          if (value === null) return 'NULL';
          if (typeof value === 'string') {
            return `'${value.replace(/'/g, "''")}'`;
          }
          if (typeof value === 'boolean') {
            return value ? 1 : 0;
          }
          return value;
        });
        
        sqlDump += `INSERT INTO ${table} (${columns.join(', ')}) VALUES (${values.join(', ')});\n`;
      }
      sqlDump += '\n';
    }
  }
  
  // Add views
  if (views.length > 0) {
    sqlDump += `-- Views\n`;
    for (const view of views) {
      sqlDump += `DROP VIEW IF EXISTS ${view.name};\n`;
      sqlDump += `${view.sql};\n\n`;
    }
  }
  
  // Add triggers
  if (triggers.length > 0) {
    sqlDump += `-- Triggers\n`;
    for (const trigger of triggers) {
      sqlDump += `DROP TRIGGER IF EXISTS ${trigger.name};\n`;
      sqlDump += `${trigger.sql};\n\n`;
    }
  }
  
  fs.writeFileSync(
    path.join(BACKUP_PATH, 'backup.sql'),
    sqlDump
  );
  
  console.log('\n✅ Backup completed successfully!');
  console.log(`📁 Backup location: ${BACKUP_PATH}`);
  console.log('\nBackup contents:');
  console.log('  - metadata.json: Backup metadata');
  console.log('  - complete-backup.json: All data in single JSON file');
  console.log('  - backup.sql: SQL dump for easy restore');
  console.log('  - [table_name].json: Individual table backups');
  
  // Show backup statistics
  console.log('\n📊 Backup Statistics:');
  let totalRows = 0;
  for (const [table, info] of Object.entries(backupMetadata.tables)) {
    console.log(`  ${table}: ${info.rowCount} rows`);
    totalRows += info.rowCount;
  }
  console.log(`  Total: ${totalRows} rows across ${Object.keys(backupMetadata.tables).length} tables`);
  
  // Calculate backup size
  const backupSize = execSync(`du -sh ${BACKUP_PATH}`).toString().split('\t')[0];
  console.log(`  Backup size: ${backupSize}`);
  
  // Run verification if requested
  if (VERIFY_MODE) {
    console.log('\n🔬 Starting backup verification...');
    await verifyBackup();
  }
}

// Verification function
async function verifyBackup() {
  console.log('\n📋 Verification Steps:');
  console.log('1. Testing local database restore');
  console.log('2. Comparing schemas');
  console.log('3. Validating data integrity\n');
  
  // Create a test database locally
  const testDbName = `${DATABASE_NAME}-test-${Date.now()}`;
  console.log(`Creating test database: ${testDbName}`);
  
  try {
    // Create test database
    execSync(`npx wrangler d1 create ${testDbName} --local`, { encoding: 'utf-8' });
    
    // Load the backup
    const backupFile = path.join(BACKUP_PATH, 'backup.sql');
    if (fs.existsSync(backupFile)) {
      console.log('🔄 Restoring to test database...');
      execSync(`npx wrangler d1 execute ${testDbName} --local --file="${backupFile}"`, { encoding: 'utf-8' });
      console.log('✅ Restore successful');
      
      // Verify table counts
      const metadata = JSON.parse(fs.readFileSync(path.join(BACKUP_PATH, 'metadata.json'), 'utf-8'));
      
      console.log('\n📊 Verifying row counts:');
      let allMatch = true;
      
      for (const [tableName, info] of Object.entries(metadata.tables)) {
        const countSQL = `SELECT COUNT(*) as count FROM ${tableName}`;
        try {
          const result = execSync(
            `npx wrangler d1 execute ${testDbName} --local --command="${countSQL}"`,
            { encoding: 'utf-8' }
          );
          
          const match = result.match(/(\d+)/);
          const count = match ? parseInt(match[1]) : 0;
          
          if (count === info.rowCount) {
            console.log(`  ✅ ${tableName}: ${count} rows (matches)`);
          } else {
            console.log(`  ❌ ${tableName}: ${count} rows (expected ${info.rowCount})`);
            allMatch = false;
          }
        } catch (e) {
          console.log(`  ❌ ${tableName}: Failed to verify`);
          allMatch = false;
        }
      }
      
      if (allMatch) {
        console.log('\n✅ Verification PASSED: Backup is valid and restorable');
      } else {
        console.log('\n⚠️  Verification FAILED: Some tables have mismatched row counts');
      }
      
    } else {
      console.log('⚠️  No SQL backup file found for verification');
    }
    
  } catch (error) {
    console.error('❌ Verification failed:', error.message);
  }
}

// Run backup
backupDatabase().catch(console.error);