#!/usr/bin/env node
// Script to populate sims table from CSV via Cloudflare Workers API
// New schema: includes sim_index, phone_number, country_code, carrier, imei
import fs from 'fs';
import { parse } from 'csv-parse/sync';

const API_URL = 'http://localhost:8787';  // Local API for testing
const CSV_PATH = '../phone_number_list.csv';

// Helper function to derive country code from phone number
function deriveCountryCode(phone) {
  if (!phone) return null;
  if (phone.startsWith('+86')) return 'CN';
  if (phone.startsWith('+65')) return 'SG';
  if (phone.startsWith('+852')) return 'HK';
  return null;
}

async function main() {
  // Read CSV
  const csvContent = fs.readFileSync(CSV_PATH, 'utf-8');
  const records = parse(csvContent, {
    columns: true,
    skip_empty_lines: true
  });

  console.log(`Found ${records.length} records in CSV`);

  // Update via API
  let successCount = 0;
  let errorCount = 0;

  for (const record of records) {
    const simIndex = parseInt(record['No']);
    const phoneNumber = record['Phone Number'];
    const iccid = record['ICCID'];
    const carrier = record['运营商'];
    const countryCode = deriveCountryCode(phoneNumber);
    const imei = record['Equipment ID'] || null;  // User's intended modem binding

    try {
      const response = await fetch(`${API_URL}/api/iccid-mappings`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({
          iccid,
          phone_number: phoneNumber,
          sim_index: simIndex,
          country_code: countryCode,
          carrier: carrier || null,
          imei: imei,
          // NO status field - computed dynamically by API
        })
      });

      const result = await response.json();

      if (result.success) {
        console.log(`✓ Updated SIM ${simIndex}: ${phoneNumber} (${countryCode || 'no country'})`);
        successCount++;
      } else {
        console.error(`✗ Failed SIM ${simIndex}: ${result.error}`);
        errorCount++;
      }
    } catch (error) {
      console.error(`✗ Error updating SIM ${simIndex}:`, error.message);
      errorCount++;
    }

    // Rate limit: 100ms between requests
    await new Promise(resolve => setTimeout(resolve, 100));
  }

  console.log(`\nDone: ${successCount} success, ${errorCount} errors`);
}

main().catch(console.error);
