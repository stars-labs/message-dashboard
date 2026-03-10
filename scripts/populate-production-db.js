#!/usr/bin/env node
// Script to populate production D1 sims table directly from CSV
import fs from 'fs';
import { parse } from 'csv-parse/sync';
import { exec } from 'child_process';
import { promisify } from 'util';

const execAsync = promisify(exec);
const CSV_PATH = './phone_number_list.csv';

// Helper function to derive country code from phone number
function deriveCountryCode(phone) {
  if (!phone) return null;
  if (phone.startsWith('+86')) return 'CN';
  if (phone.startsWith('+65')) return 'SG';
  if (phone.startsWith('+852')) return 'HK';
  return null;
}

// Escape single quotes for SQL
function escapeSql(str) {
  return str ? str.replace(/'/g, "''") : null;
}

async function main() {
  // Read CSV
  const csvContent = fs.readFileSync(CSV_PATH, 'utf-8');
  const records = parse(csvContent, {
    columns: true,
    skip_empty_lines: true
  });

  console.log(`Found ${records.length} records in CSV`);

  // Build SQL INSERT statements
  const values = [];
  for (const record of records) {
    const simIndex = parseInt(record['No']);
    const phoneNumber = record['Phone Number'];
    const iccid = record['ICCID'];
    const carrier = record['运营商'];
    const countryCode = deriveCountryCode(phoneNumber);
    const imei = record['Equipment ID'] || null;

    values.push(
      `('${escapeSql(iccid)}', ${simIndex}, '${escapeSql(phoneNumber)}', ${countryCode ? `'${countryCode}'` : 'NULL'}, ${carrier ? `'${escapeSql(carrier)}'` : 'NULL'}, ${imei ? `'${escapeSql(imei)}'` : 'NULL'}, NULL, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP, 'csv-import')`
    );
  }

  const sql = `INSERT INTO sims (iccid, sim_index, phone_number, country_code, carrier, imei, notes, created_at, updated_at, updated_by) VALUES ${values.join(',\n')};`;

  // Write SQL to temp file
  const sqlFile = '/tmp/populate-sims-production.sql';
  fs.writeFileSync(sqlFile, sql);

  console.log('Executing SQL via wrangler (REMOTE)...');
  console.log('⚠️  This will modify production database!');

  try {
    const { stdout, stderr } = await execAsync(`cd sms-dashboard && bunx wrangler d1 execute sms-dashboard --remote --file=${sqlFile}`);
    console.log(stdout);
    if (stderr) console.error(stderr);
    console.log(`\n✓ Successfully inserted ${records.length} SIM records to PRODUCTION`);
  } catch (error) {
    console.error('Error executing SQL:', error.message);
    process.exit(1);
  }

  // Verify
  try {
    const { stdout } = await execAsync(`cd sms-dashboard && bunx wrangler d1 execute sms-dashboard --remote --command="SELECT COUNT(*) as count FROM sims"`);
    console.log('\nVerification (PRODUCTION):');
    console.log(stdout);
  } catch (error) {
    console.error('Error verifying:', error.message);
  }
}

main().catch(console.error);
