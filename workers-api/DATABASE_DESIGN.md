# SMS Dashboard Database Design

## Overview
The SMS Dashboard uses Cloudflare D1 (SQLite-based) database with three main tables: `phones`, `messages`, and `users`. The design supports multi-phone SMS management, message tracking, and user authentication.

## Entity Relationship Diagram

```mermaid
erDiagram
    PHONES ||--o{ MESSAGES : sends/receives
    USERS ||--o{ SESSIONS : has
    
    PHONES {
        text id PK "Unique phone identifier (e.g., SIM_001)"
        text number UK "Phone number with country code"
        text country "Country name in Chinese"
        text flag "Country flag emoji"
        text carrier "Mobile carrier name"
        text status "online/offline"
        integer signal "Signal strength (0-100)"
        timestamp updated_at "Last status update"
    }
    
    MESSAGES {
        text id PK "Unique message ID"
        text phone_id FK "Reference to phones.id"
        text phone_number "Denormalized phone number"
        text content "Message content"
        text source "Message source/sender"
        timestamp timestamp "Message timestamp"
        text type "received/sent"
        text verification_code "Extracted code"
        text recipient "For sent messages"
        text status "pending/delivered/failed"
        timestamp created_at "Record creation time"
    }
    
    USERS {
        text id PK "Unique user ID"
        text email UK "User email"
        text name "User display name"
        text provider "OAuth provider"
        timestamp created_at "Account creation"
        timestamp last_login "Last login time"
    }
```

## Table Details

### 1. PHONES Table
Stores SIM card/phone information for the SMS gateway devices.

| Column | Type | Constraints | Description |
|--------|------|-------------|-------------|
| id | TEXT | PRIMARY KEY | Unique identifier (e.g., 'SIM_001') |
| number | TEXT | NOT NULL, UNIQUE | Phone number with country code |
| country | TEXT | NOT NULL | Country name (Chinese) |
| flag | TEXT | NOT NULL | Country flag emoji |
| carrier | TEXT | NOT NULL | Mobile carrier name |
| status | TEXT | DEFAULT 'offline' | Connection status: 'online'/'offline' |
| signal | INTEGER | DEFAULT 0 | Signal strength (0-100) |
| updated_at | TIMESTAMP | DEFAULT CURRENT_TIMESTAMP | Last status update |

**Indexes:**
- `idx_phones_status` on `status` - Quick filtering by online/offline phones

### 2. MESSAGES Table
Stores all SMS messages (both received and sent).

| Column | Type | Constraints | Description |
|--------|------|-------------|-------------|
| id | TEXT | PRIMARY KEY | Unique message ID |
| phone_id | TEXT | NOT NULL, FOREIGN KEY | References phones.id |
| phone_number | TEXT | NOT NULL | Denormalized for performance |
| content | TEXT | NOT NULL | Full message content |
| source | TEXT | NULL | Sender information (for received) |
| timestamp | TIMESTAMP | NOT NULL | Message send/receive time |
| type | TEXT | CHECK IN ('received', 'sent') | Message direction |
| verification_code | TEXT | NULL | Auto-extracted verification code |
| recipient | TEXT | NULL | Recipient number (for sent) |
| status | TEXT | NULL | Delivery status (for sent) |
| created_at | TIMESTAMP | DEFAULT CURRENT_TIMESTAMP | Database record creation |

**Indexes:**
- `idx_messages_phone_id` on `phone_id` - Fast message lookup by phone
- `idx_messages_timestamp` on `timestamp DESC` - Recent messages first
- `idx_messages_type` on `type` - Filter by message direction

### 3. USERS Table
Stores authenticated user information from OAuth providers.

| Column | Type | Constraints | Description |
|--------|------|-------------|-------------|
| id | TEXT | PRIMARY KEY | Unique user ID |
| email | TEXT | NOT NULL, UNIQUE | User email address |
| name | TEXT | NULL | Display name |
| provider | TEXT | NOT NULL | OAuth provider (google, github, etc.) |
| created_at | TIMESTAMP | DEFAULT CURRENT_TIMESTAMP | First login |
| last_login | TIMESTAMP | NULL | Most recent login |

## Key Design Decisions

### 1. Denormalization
- `phone_number` is stored in messages table to avoid joins for display
- Improves query performance for message lists

### 2. Verification Code Extraction
- `verification_code` field stores automatically extracted codes
- Enables quick filtering and statistics on verification messages

### 3. Message Status Tracking
- `status` field tracks delivery status for sent messages
- Supports real-time updates via WebSocket

### 4. Flexible Phone IDs
- Using TEXT IDs (e.g., 'SIM_001') instead of auto-increment
- Easier integration with physical SIM slot mapping

### 5. Timestamp Strategy
- `timestamp` - Actual message time
- `created_at` - Database insertion time
- Helps track delays and system performance

## Query Patterns

### Common Queries

1. **Get recent messages for a phone**
```sql
SELECT * FROM messages 
WHERE phone_id = ? 
ORDER BY timestamp DESC 
LIMIT 50;
```

2. **Get online phones with signal strength**
```sql
SELECT * FROM phones 
WHERE status = 'online' 
ORDER BY signal DESC;
```

3. **Get today's message count**
```sql
SELECT COUNT(*) as today_messages 
FROM messages 
WHERE DATE(timestamp) = DATE('now');
```

4. **Get verification code success rate**
```sql
SELECT 
  COUNT(*) as total,
  COUNT(verification_code) as with_code,
  ROUND(COUNT(verification_code) * 100.0 / COUNT(*), 2) as success_rate
FROM messages 
WHERE type = 'received';
```

5. **Get messages with verification codes**
```sql
SELECT * FROM messages 
WHERE verification_code IS NOT NULL 
ORDER BY timestamp DESC;
```

## Data Volume Considerations

- **Phones**: ~95 records (fixed, based on hardware)
- **Messages**: Grows continuously, needs periodic cleanup
- **Users**: Limited by authentication system

## Maintenance Queries

### Archive old messages (30+ days)
```sql
DELETE FROM messages 
WHERE timestamp < datetime('now', '-30 days');
```

### Update phone status in bulk
```sql
UPDATE phones 
SET status = 'offline', signal = 0 
WHERE updated_at < datetime('now', '-5 minutes');
```

## Future Enhancements

1. **Message Templates Table**
   - Store common SMS templates
   - Quick compose functionality

2. **API Keys Table**
   - Multiple API keys for Orange Pi devices
   - Access control and rate limiting

3. **Message Analytics Table**
   - Aggregated statistics
   - Performance metrics

4. **Phone Groups Table**
   - Organize phones by region/purpose
   - Bulk operations support