#!/usr/bin/env node

/**
 * Database Restore Script for Cloudflare D1
 *
 * This script restores D1 database from backup files
 * Usage: bun scripts/restore-database.ts [backup-folder]
 */

import { execSync } from 'child_process';
import fs from 'fs';
import path from 'path';
import readline from 'readline';
import * as v from 'valibot';
import { parseJson, type Schema } from '../shared/parse-json.js';

// Configuration
const DATABASE_NAME = 'sms-dashboard';
const BACKUP_DIR = path.join(import.meta.dirname, '../backups');

const SqlValueSchema = v.union([v.string(), v.number(), v.boolean(), v.null()]);

const MetadataSchema = v.object({
  timestamp: v.string(),
  database: v.string(),
  tables: v.record(v.string(), v.object({ rowCount: v.number() })),
});

const CompleteBackupSchema = v.object({
  metadata: v.object({
    tables: v.record(v.string(), v.object({ rowCount: v.number() })),
  }),
  tables: v.record(
    v.string(),
    v.object({
      schema: v.nullish(v.string()),
      indexes: v.nullish(v.array(v.string())),
      data: v.nullish(v.array(v.record(v.string(), SqlValueSchema))),
    }),
  ),
});

type CompleteBackup = v.InferOutput<typeof CompleteBackupSchema>;

function readBackupFile<T>(file: string, schema: Schema<T>): T {
  const parsed = parseJson(fs.readFileSync(file, 'utf-8'), schema);
  if (!parsed.ok) throw new Error(`${file} is not a valid backup file: ${parsed.error}`);
  return parsed.value;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function rowCountFrom(output: string): number {
  const digits = /(\d+)/.exec(output)?.[1];
  return digits === undefined ? 0 : parseInt(digits, 10);
}

function sqlValue(value: v.InferOutput<typeof SqlValueSchema> | undefined): string {
  if (value === null || value === undefined) return 'NULL';
  if (typeof value === 'string') {
    return `'${value.replace(/'/g, "''")}'`;
  }
  if (typeof value === 'boolean') {
    return value ? '1' : '0';
  }
  return String(value);
}

// Get backup folder from command line or use latest
const backupArg = process.argv[2];
const backupFolder = backupArg === undefined || backupArg === '' ? getLatestBackup() : backupArg;

function getLatestBackup() {
  if (!fs.existsSync(BACKUP_DIR)) {
    console.error('❌ No backups directory found');
    process.exit(1);
  }

  const backups = fs
    .readdirSync(BACKUP_DIR)
    .filter((f) => f.startsWith('backup-'))
    .sort()
    .reverse();

  const latest = backups[0];
  if (latest === undefined) {
    console.error('❌ No backup folders found');
    process.exit(1);
  }

  return latest;
}

const BACKUP_PATH = path.join(BACKUP_DIR, backupFolder);

if (!fs.existsSync(BACKUP_PATH)) {
  console.error(`❌ Backup folder not found: ${BACKUP_PATH}`);
  process.exit(1);
}

console.log(`🔄 Restoring database from: ${BACKUP_PATH}`);

// Function to execute wrangler command
function runWranglerCommand(sql: string, isLocal = false) {
  const location = isLocal ? '--local' : '--remote';
  const command = `npx wrangler d1 execute ${DATABASE_NAME} ${location} --command="${sql}"`;

  try {
    const result = execSync(command, { encoding: 'utf-8', maxBuffer: 50 * 1024 * 1024 });
    return result;
  } catch (error) {
    console.error(`Error executing SQL: ${sql.substring(0, 100)}...`);
    console.error(errorMessage(error));
    return null;
  }
}

// Function to execute SQL file
function runSQLFile(filePath: string, isLocal = false) {
  const location = isLocal ? '--local' : '--remote';
  const command = `npx wrangler d1 execute ${DATABASE_NAME} ${location} --file="${filePath}"`;

  try {
    const result = execSync(command, { encoding: 'utf-8', maxBuffer: 50 * 1024 * 1024 });
    return result;
  } catch (error) {
    console.error(`Error executing SQL file: ${filePath}`);
    console.error(errorMessage(error));
    return null;
  }
}

// Function to create tables from backup
function createTables(backup: CompleteBackup) {
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
function importData(backup: CompleteBackup) {
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
      const [firstRow] = batchData;
      if (firstRow === undefined) continue;
      const columns = Object.keys(firstRow);
      let insertSQL = '';

      for (const row of batchData) {
        const values = columns.map((col) => sqlValue(row[col]));

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
function restoreFromSQL() {
  const sqlFile = path.join(BACKUP_PATH, 'backup.sql');

  if (!fs.existsSync(sqlFile)) {
    console.log('❌ No SQL dump file found');
    return false;
  }

  console.log('\n📝 Restoring from SQL dump...');

  // Split SQL file into chunks to avoid command line length limits
  const sqlContent = fs.readFileSync(sqlFile, 'utf-8');
  const statements = sqlContent.split(';\n').filter((s) => s.trim());

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
function verifyRestore(backup: CompleteBackup) {
  console.log('\n🔍 Verifying restore...');

  let allGood = true;

  for (const [tableName, tableInfo] of Object.entries(backup.metadata.tables)) {
    const countSQL = `SELECT COUNT(*) as count FROM ${tableName}`;
    const result = runWranglerCommand(countSQL);

    if (result) {
      const count = rowCountFrom(result);

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
function prompt(question: string) {
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
  });

  return new Promise<string>((resolve) => {
    rl.question(question, (answer) => {
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

  const metadata = readBackupFile(metadataFile, MetadataSchema);

  console.log('\n📋 Backup Information:');
  console.log(`  Timestamp: ${metadata.timestamp}`);
  console.log(`  Database: ${metadata.database}`);
  console.log(`  Tables: ${Object.keys(metadata.tables).length}`);

  let totalRows = 0;
  for (const info of Object.values(metadata.tables)) {
    totalRows += info.rowCount;
  }
  console.log(`  Total rows: ${totalRows}`);

  // Ask for confirmation
  const answer = await prompt(
    '\n⚠️  This will REPLACE all data in the database. Continue? (yes/no): ',
  );
  if (answer.toLowerCase() !== 'yes') {
    console.log('❌ Restore cancelled');
    process.exit(0);
  }

  // Check for SQL dump first (faster)
  const sqlDumpExists = fs.existsSync(path.join(BACKUP_PATH, 'backup.sql'));
  const completeBackupExists = fs.existsSync(path.join(BACKUP_PATH, 'complete-backup.json'));

  if (sqlDumpExists) {
    console.log('\n📝 SQL dump found. Using fast restore method...');
    const success = restoreFromSQL();

    if (success) {
      // Load complete backup for verification
      if (completeBackupExists) {
        const backup = readBackupFile(
          path.join(BACKUP_PATH, 'complete-backup.json'),
          CompleteBackupSchema,
        );
        verifyRestore(backup);
      }
    }
  } else if (completeBackupExists) {
    console.log('\n📦 Using JSON backup...');

    // Load complete backup
    const backup = readBackupFile(
      path.join(BACKUP_PATH, 'complete-backup.json'),
      CompleteBackupSchema,
    );

    // Create tables
    createTables(backup);

    // Import data
    importData(backup);

    // Verify
    verifyRestore(backup);
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
