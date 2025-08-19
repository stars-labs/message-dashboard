#!/bin/bash

echo "Please follow these steps to create D1 database:"
echo ""
echo "1. Go to: https://dash.cloudflare.com/?to=/:account/workers/d1"
echo "2. Click 'Create database'"
echo "3. Name it: sms-dashboard"
echo "4. Create it and copy the Database ID"
echo ""
echo "Once created, the Database ID will look like: xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx"
echo ""
read -p "Enter the Database ID here: " db_id

if [ -z "$db_id" ]; then
    echo "No database ID provided"
    exit 1
fi

echo ""
echo "Updating wrangler.toml with new database ID..."

# Update the database_id in wrangler.toml
sed -i "s/database_id = \".*\"/database_id = \"$db_id\"/" wrangler.toml

echo "✅ Updated wrangler.toml with database ID: $db_id"
echo ""
echo "Testing connection..."
npx wrangler d1 execute sms-dashboard --command="SELECT 1" --local

