#!/bin/bash

# D1 Database Backup Script
# Simple wrapper for backup operations

set -e

SCRIPT_DIR="$( cd "$( dirname "${BASH_SOURCE[0]}" )" && pwd )"
cd "$SCRIPT_DIR"

# Colors for output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m' # No Color

echo -e "${GREEN}🚀 D1 Database Backup Tool${NC}"
echo "=========================="

# Check if node is installed
if ! command -v node &> /dev/null; then
    echo -e "${RED}❌ Node.js is not installed${NC}"
    exit 1
fi

# Check if wrangler is installed
if ! command -v npx &> /dev/null; then
    echo -e "${RED}❌ npx is not installed${NC}"
    exit 1
fi

# Function to show menu
show_menu() {
    echo ""
    echo "Select an option:"
    echo "1) Backup database (full)"
    echo "2) Backup database (with verification)"
    echo "3) Backup from local database"
    echo "4) List existing backups"
    echo "5) Verify a backup"
    echo "6) Restore from backup"
    echo "7) Delete old backups (keep last 30 days)"
    echo "8) Export as SQL only"
    echo "9) Schedule automatic backups (cron)"
    echo "0) Exit"
    echo ""
    read -p "Enter choice [0-9]: " choice
}

# Full backup
backup_full() {
    echo -e "${YELLOW}Starting full database backup...${NC}"
    node scripts/backup-database.js
}

# Backup with verification
backup_with_verify() {
    echo -e "${YELLOW}Starting database backup with verification...${NC}"
    node scripts/backup-database.js --verify
}

# Backup from local
backup_local() {
    echo -e "${YELLOW}Starting backup from LOCAL database...${NC}"
    node scripts/backup-database.js --local
}

# Verify backup
verify_backup() {
    list_backups
    
    read -p "Enter backup folder name to verify (or press Enter for latest): " backup_name
    
    if [ -z "$backup_name" ]; then
        echo -e "${YELLOW}Verifying latest backup...${NC}"
        node scripts/verify-backup.js
    else
        node scripts/verify-backup.js "$backup_name"
    fi
}

# Schema only backup
backup_schema() {
    echo -e "${YELLOW}Starting schema-only backup...${NC}"
    
    TIMESTAMP=$(date +"%Y-%m-%dT%H-%M-%S")
    BACKUP_DIR="backups/schema-${TIMESTAMP}"
    mkdir -p "$BACKUP_DIR"
    
    # Get all table schemas
    echo "Exporting schemas..."
    npx wrangler d1 execute sms-dashboard --remote --command="
        SELECT sql FROM sqlite_master 
        WHERE type='table' AND sql NOT NULL
    " > "$BACKUP_DIR/schemas.sql"
    
    # Get all indexes
    echo "Exporting indexes..."
    npx wrangler d1 execute sms-dashboard --remote --command="
        SELECT sql FROM sqlite_master 
        WHERE type='index' AND sql NOT NULL
    " > "$BACKUP_DIR/indexes.sql"
    
    echo -e "${GREEN}✅ Schema backup completed: $BACKUP_DIR${NC}"
}

# List backups
list_backups() {
    echo -e "${YELLOW}Available backups:${NC}"
    echo ""
    
    if [ -d "backups" ]; then
        for dir in backups/*/; do
            if [ -d "$dir" ]; then
                dirname=$(basename "$dir")
                size=$(du -sh "$dir" | cut -f1)
                
                # Check what files exist
                files=""
                [ -f "$dir/complete-backup.json" ] && files="${files} [JSON]"
                [ -f "$dir/backup.sql" ] && files="${files} [SQL]"
                [ -f "$dir/metadata.json" ] && files="${files} [META]"
                
                echo "  📁 $dirname ($size)$files"
                
                # Show metadata if exists
                if [ -f "$dir/metadata.json" ]; then
                    tables=$(grep -o '"tables":{[^}]*}' "$dir/metadata.json" | grep -o '"[^"]*":' | wc -l)
                    echo "     Tables: $tables"
                fi
            fi
        done
    else
        echo -e "${RED}No backups found${NC}"
    fi
    echo ""
}

# Restore from backup
restore_backup() {
    list_backups
    
    read -p "Enter backup folder name (or press Enter for latest): " backup_name
    
    if [ -z "$backup_name" ]; then
        echo -e "${YELLOW}Using latest backup...${NC}"
        node scripts/restore-database.js
    else
        node scripts/restore-database.js "$backup_name"
    fi
}

# Delete old backups
cleanup_backups() {
    echo -e "${YELLOW}Cleaning up backups older than 30 days...${NC}"
    
    if [ -d "backups" ]; then
        count=0
        for dir in backups/*/; do
            if [ -d "$dir" ]; then
                # Check if directory is older than 30 days
                if [ $(find "$dir" -maxdepth 0 -type d -mtime +30 | wc -l) -gt 0 ]; then
                    echo "  Deleting: $(basename "$dir")"
                    rm -rf "$dir"
                    ((count++))
                fi
            fi
        done
        
        if [ $count -eq 0 ]; then
            echo "No old backups to delete"
        else
            echo -e "${GREEN}✅ Deleted $count old backup(s)${NC}"
        fi
    else
        echo "No backups directory found"
    fi
}

# Export SQL only
export_sql() {
    echo -e "${YELLOW}Exporting database as SQL...${NC}"
    
    TIMESTAMP=$(date +"%Y-%m-%dT%H-%M-%S")
    OUTPUT_FILE="backups/export-${TIMESTAMP}.sql"
    mkdir -p backups
    
    npx wrangler d1 export sms-dashboard --output="$OUTPUT_FILE" --remote
    
    if [ -f "$OUTPUT_FILE" ]; then
        size=$(du -sh "$OUTPUT_FILE" | cut -f1)
        echo -e "${GREEN}✅ SQL export completed: $OUTPUT_FILE ($size)${NC}"
    else
        echo -e "${RED}❌ SQL export failed${NC}"
    fi
}

# Schedule automatic backups
schedule_backups() {
    echo -e "${YELLOW}Setting up automatic backups...${NC}"
    echo ""
    echo "Choose backup frequency:"
    echo "1) Daily at 2 AM"
    echo "2) Weekly on Sunday at 2 AM"
    echo "3) Monthly on 1st at 2 AM"
    echo "4) Custom cron expression"
    echo ""
    read -p "Enter choice [1-4]: " freq_choice
    
    case $freq_choice in
        1) CRON="0 2 * * *" ;;
        2) CRON="0 2 * * 0" ;;
        3) CRON="0 2 1 * *" ;;
        4) 
            read -p "Enter cron expression: " CRON
            ;;
        *) 
            echo -e "${RED}Invalid choice${NC}"
            return
            ;;
    esac
    
    # Create cron job
    CRON_CMD="cd $SCRIPT_DIR && /usr/bin/node scripts/backup-database.js >> backups/cron.log 2>&1"
    
    # Check if cron job already exists
    if crontab -l 2>/dev/null | grep -q "backup-database.js"; then
        echo -e "${YELLOW}Cron job already exists. Replace it? (y/n)${NC}"
        read -p "> " replace
        if [ "$replace" != "y" ]; then
            return
        fi
        # Remove old cron job
        crontab -l | grep -v "backup-database.js" | crontab -
    fi
    
    # Add new cron job
    (crontab -l 2>/dev/null; echo "$CRON $CRON_CMD") | crontab -
    
    echo -e "${GREEN}✅ Automatic backup scheduled!${NC}"
    echo "Cron expression: $CRON"
    echo "Command: $CRON_CMD"
    echo ""
    echo "View cron jobs: crontab -l"
    echo "Remove cron job: crontab -l | grep -v 'backup-database.js' | crontab -"
}

# Main loop
while true; do
    show_menu
    
    case $choice in
        1) backup_full ;;
        2) backup_with_verify ;;
        3) backup_local ;;
        4) list_backups ;;
        5) verify_backup ;;
        6) restore_backup ;;
        7) cleanup_backups ;;
        8) export_sql ;;
        9) schedule_backups ;;
        0) 
            echo -e "${GREEN}Goodbye!${NC}"
            exit 0
            ;;
        *)
            echo -e "${RED}Invalid option${NC}"
            ;;
    esac
    
    echo ""
    read -p "Press Enter to continue..."
done