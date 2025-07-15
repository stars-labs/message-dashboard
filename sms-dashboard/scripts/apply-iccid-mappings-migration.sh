#!/bin/bash

# Script to apply the ICCID mappings migration to the D1 database

echo "Applying ICCID mappings migration..."

# First, check if the table already exists
echo "Checking if iccid_mappings table exists..."
npx wrangler d1 execute sms-dashboard --command "SELECT name FROM sqlite_master WHERE type='table' AND name='iccid_mappings';"

# Apply the migration
echo "Applying migration 0004_add_iccid_mappings.sql..."
npx wrangler d1 migrations apply sms-dashboard

# Verify the table was created
echo "Verifying table creation..."
npx wrangler d1 execute sms-dashboard --command "SELECT sql FROM sqlite_master WHERE type='table' AND name='iccid_mappings';"

# Check table structure
echo "Checking table structure..."
npx wrangler d1 execute sms-dashboard --command "PRAGMA table_info(iccid_mappings);"

echo "Migration complete!"