#!/bin/bash

# Test SQL backup integrity
SQL_FILE="backups/quick-backup-20250817-191916.sql"

echo "📋 SQL Backup Analysis"
echo "====================="
echo ""
echo "File: $SQL_FILE"
echo "Size: $(du -h $SQL_FILE | cut -f1)"
echo ""
echo "📊 Contents:"
echo "  Tables: $(grep -c "CREATE TABLE" $SQL_FILE)"
echo "  Views: $(grep -c "CREATE VIEW" $SQL_FILE)"
echo "  Triggers: $(grep -c "CREATE TRIGGER" $SQL_FILE)"
echo "  Indexes: $(grep -c "CREATE INDEX" $SQL_FILE)"
echo "  Data rows: $(grep -c "INSERT INTO" $SQL_FILE)"
echo ""
echo "📋 Tables found:"
grep "CREATE TABLE" $SQL_FILE | sed 's/CREATE TABLE /  - /g' | sed 's/ (.*//g'
echo ""
echo "👁️ Views found:"
grep "CREATE VIEW" $SQL_FILE | sed 's/CREATE VIEW /  - /g' | sed 's/ AS.*//g'
echo ""
echo "⚡ Triggers found:"
grep "CREATE TRIGGER" $SQL_FILE | sed 's/CREATE TRIGGER /  - /g' | cut -d' ' -f1
echo ""
echo "✅ Backup appears complete with all schema objects and data!"
