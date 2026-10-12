#!/usr/bin/env bun

import { Database } from 'bun:sqlite';
import { readFileSync } from 'fs';
import { join } from 'path';

const dbPath = './data/sqlite.db';
console.log(`Initializing database at: ${dbPath}`);

// Create database
const db = new Database(dbPath, { create: true });

// Read and execute schema
const schemaPath = join(import.meta.dir, '../migrations/schema.sql');
const schema = readFileSync(schemaPath, 'utf-8');

// Remove comments and split by semicolon
const cleanSchema = schema
  .split('\n')
  .filter(line => !line.trim().startsWith('--'))
  .join('\n');

// Execute the entire schema as one transaction
console.log('Creating database schema...');

try {
  // Execute the entire schema
  db.exec(cleanSchema);
  console.log('✅ Schema executed successfully!');
} catch (error) {
  console.error('Failed to execute schema:', error.message);
  
  // Try to execute statement by statement as fallback
  console.log('Trying statement by statement...');
  const statements = cleanSchema
    .split(';')
    .map(s => s.trim())
    .filter(s => s.length > 0);
  
  for (const statement of statements) {
    try {
      db.exec(statement + ';');
    } catch (err) {
      console.error(`Failed: ${statement.slice(0, 50)}... - ${err.message}`);
    }
  }
}

console.log('✅ Database initialized successfully!');

// Verify tables were created
const tables = db.query("SELECT name FROM sqlite_master WHERE type='table'").all();
console.log(`Created ${tables.length} tables:`, tables.map(t => t.name).join(', '));

db.close();