# SQLite Message Queue Implementation

## Overview

Version 6.0.0 of the SMS daemon introduces a local SQLite database for reliable message handling. This solves critical issues with message loss and SIM card overflow that were occurring in previous versions.

## Problems Solved

### Before (v5.x)
- ❌ Messages deleted from SIM immediately after reading
- ❌ If API upload failed, messages were lost forever
- ❌ No deduplication - same messages uploaded multiple times
- ❌ SIM cards filling up with 900+ messages
- ❌ No visibility into message processing status

### After (v6.0)
- ✅ Messages saved to local SQLite database first
- ✅ Messages deleted from SIM only after successful upload
- ✅ Built-in deduplication (matching server logic)
- ✅ Automatic retry for failed uploads
- ✅ SIM card storage monitoring
- ✅ Complete audit trail of all messages

## Architecture

```
SIM Card → Read SMS → SQLite DB → Upload Queue → API → Delete from SIM
             ↓                        ↓
        (Keep on SIM)          (Retry on failure)
```

## Database Schema

### Messages Table
```sql
CREATE TABLE messages (
    id INTEGER PRIMARY KEY,
    phone_iccid TEXT NOT NULL,      -- SIM card identifier
    phone_number TEXT NOT NULL,     -- Sender's phone number
    content TEXT NOT NULL,          -- Message content
    timestamp TEXT NOT NULL,        -- When received
    modem_id TEXT NOT NULL,         -- Which modem received it
    sms_path TEXT NOT NULL,         -- D-Bus path for deletion
    status TEXT DEFAULT 'pending',  -- pending/uploading/uploaded/failed
    attempts INTEGER DEFAULT 0,     -- Upload attempt count
    created_at TIMESTAMP,           -- When stored locally
    uploaded_at TIMESTAMP,          -- When uploaded to API
    deleted_at TIMESTAMP,           -- When deleted from SIM
    error TEXT,                     -- Last error message
    UNIQUE(phone_iccid, timestamp, content) -- Deduplication
)
```

### SIM Storage Table
```sql
CREATE TABLE sim_storage (
    iccid TEXT PRIMARY KEY,
    total_messages INTEGER DEFAULT 0,    -- Messages received
    deleted_messages INTEGER DEFAULT 0,  -- Messages deleted
    last_check TIMESTAMP,
    is_full BOOLEAN DEFAULT 0            -- Alert when >200 messages
)
```

## Message Flow

### 1. Reading from SIM
```rust
// Messages are read but NOT deleted
let messages_with_paths = modem_manager.get_new_messages_with_paths(modem_id, iccid);

// Store in SQLite (with deduplication)
for msg in messages_with_paths {
    message_store.store_message(&msg.message, &msg.modem_id, &msg.sms_path);
}
```

### 2. Upload Process
```rust
// Get pending messages from database
let pending = message_store.get_pending_messages(100);

// Mark as uploading (prevent duplicate processing)
message_store.mark_uploading(&message_ids);

// Try to upload
match api_client.upload_messages(&messages).await {
    Ok(_) => message_store.mark_uploaded(&message_ids),
    Err(e) => message_store.mark_failed(&message_ids, &error)
}
```

### 3. SIM Cleanup
```rust
// Only delete messages that were successfully uploaded
let deletable = message_store.get_deletable_sms();

for (modem_id, sms_path) in deletable {
    modem_manager.delete_sms(&modem_id, &sms_path).await;
    message_store.mark_sms_deleted(&modem_id, &sms_path);
}
```

## Configuration

### Environment Variables
```bash
# Database location (default: /var/lib/sms-daemon/messages.db)
MESSAGE_DB_PATH=/var/lib/sms-daemon/messages.db

# Standard SMS daemon configuration
SMS_API_URL=https://sexy.qzz.io
SMS_API_KEY=your-api-key
CHECK_INTERVAL_SECS=30
RUST_LOG=info
```

### NixOS Configuration
```nix
services.sms-daemon = {
    enable = true;
    package = pkgs.sms-daemon;  # v6.0.0+
    environment = {
        MESSAGE_DB_PATH = "/var/lib/sms-daemon/messages.db";
    };
};
```

## Features

### 1. Deduplication
- Matches server-side logic (10-second window)
- Prevents duplicate uploads
- Based on ICCID + timestamp + content

### 2. Retry Logic
- Failed messages retry up to 5 times
- Exponential backoff between retries
- Clear error tracking

### 3. Storage Monitoring
- Tracks messages per SIM card
- Warns when SIM >200 messages
- Automatic cleanup of old messages (>7 days)

### 4. Statistics
```
📊 Message store (24h): 45 pending, 2 uploading, 892 uploaded, 3 failed (total: 942)
```

## Monitoring

### Check Database Status
```bash
sqlite3 /var/lib/sms-daemon/messages.db "SELECT status, COUNT(*) FROM messages GROUP BY status;"
```

### View Failed Messages
```bash
sqlite3 /var/lib/sms-daemon/messages.db "SELECT * FROM messages WHERE status = 'failed';"
```

### Check SIM Storage
```bash
sqlite3 /var/lib/sms-daemon/messages.db "SELECT * FROM sim_storage WHERE is_full = 1;"
```

### Monitor Logs
```bash
journalctl -u sms-daemon -f | grep -E "(Message store|Uploading|Cleaning)"
```

## Benefits

1. **Zero Message Loss**: Messages are never deleted until confirmed uploaded
2. **Handles API Downtime**: Messages queue locally when API is unavailable
3. **Prevents SIM Overflow**: Monitors and cleans SIM cards proactively
4. **Complete Audit Trail**: Every message tracked from receipt to deletion
5. **Automatic Recovery**: Failed uploads retry automatically

## Migration from v5.x

1. Deploy v6.0.0 daemon
2. Database created automatically at first run
3. Existing messages on SIM cards will be:
   - Read and stored in SQLite
   - Uploaded to API
   - Deleted from SIM only after successful upload
4. No manual intervention required

## Troubleshooting

### Database Locked
```bash
# Stop daemon
systemctl stop sms-daemon

# Check database integrity
sqlite3 /var/lib/sms-daemon/messages.db "PRAGMA integrity_check;"

# Restart daemon
systemctl start sms-daemon
```

### Reset Failed Messages
```sql
UPDATE messages SET status = 'pending', attempts = 0 WHERE status = 'failed';
```

### Force Cleanup
```sql
-- Delete uploaded messages older than 1 day
DELETE FROM messages WHERE status = 'uploaded' AND uploaded_at < datetime('now', '-1 day');
```

## Performance

- Database uses WAL mode for concurrency
- Indexes on status and timestamp
- Batch operations for efficiency
- Typical overhead: <5ms per message
- Database size: ~1MB per 10,000 messages

## Security

- Database file permissions: 600 (owner only)
- No sensitive data in logs
- API keys never stored in database
- Messages encrypted at rest if filesystem encrypted