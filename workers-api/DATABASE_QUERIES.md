# SMS Dashboard Database Queries

## Dashboard Statistics Queries

### 1. Get Dashboard Overview Stats
```sql
-- Get all dashboard statistics in one query
WITH message_stats AS (
  SELECT 
    COUNT(*) as total_messages,
    COUNT(CASE WHEN DATE(timestamp) = DATE('now') THEN 1 END) as today_messages,
    COUNT(verification_code) as messages_with_code
  FROM messages
),
phone_stats AS (
  SELECT 
    COUNT(*) as total_phones,
    COUNT(CASE WHEN status = 'online' THEN 1 END) as online_phones
  FROM phones
)
SELECT 
  ms.total_messages,
  ms.today_messages,
  ps.total_phones,
  ps.online_phones,
  ROUND(ms.messages_with_code * 100.0 / NULLIF(ms.total_messages, 0), 2) as verification_rate
FROM message_stats ms, phone_stats ps;
```

### 2. Get Recent Messages with Phone Info
```sql
SELECT 
  m.*,
  p.country,
  p.flag,
  p.carrier,
  p.status as phone_status
FROM messages m
JOIN phones p ON m.phone_id = p.id
ORDER BY m.timestamp DESC
LIMIT 50;
```

### 3. Get Messages by Phone with Pagination
```sql
SELECT * FROM messages 
WHERE phone_id = ?
ORDER BY timestamp DESC
LIMIT ? OFFSET ?;
```

## Phone Management Queries

### 1. Get All Phones with Message Count
```sql
SELECT 
  p.*,
  COUNT(m.id) as message_count,
  MAX(m.timestamp) as last_message_time
FROM phones p
LEFT JOIN messages m ON p.id = m.phone_id
GROUP BY p.id
ORDER BY p.status DESC, p.signal DESC;
```

### 2. Update Phone Status (from Orange Pi)
```sql
-- Update single phone status
UPDATE phones 
SET status = ?, signal = ?, updated_at = CURRENT_TIMESTAMP
WHERE id = ?;

-- Bulk update phones to offline if not updated recently
UPDATE phones 
SET status = 'offline', signal = 0
WHERE updated_at < datetime('now', '-5 minutes')
AND status = 'online';
```

## Message Analytics Queries

### 1. Messages by Country
```sql
SELECT 
  p.country,
  p.flag,
  COUNT(m.id) as message_count,
  COUNT(m.verification_code) as codes_extracted
FROM phones p
JOIN messages m ON p.id = m.phone_id
GROUP BY p.country, p.flag
ORDER BY message_count DESC;
```

### 2. Hourly Message Distribution
```sql
SELECT 
  strftime('%H', timestamp) as hour,
  COUNT(*) as message_count,
  COUNT(CASE WHEN type = 'received' THEN 1 END) as received,
  COUNT(CASE WHEN type = 'sent' THEN 1 END) as sent
FROM messages
WHERE DATE(timestamp) = DATE('now')
GROUP BY hour
ORDER BY hour;
```

### 3. Top Message Sources
```sql
SELECT 
  source,
  COUNT(*) as message_count,
  COUNT(verification_code) as with_code
FROM messages
WHERE source IS NOT NULL
GROUP BY source
ORDER BY message_count DESC
LIMIT 20;
```

## Verification Code Queries

### 1. Recent Verification Codes
```sql
SELECT 
  id,
  phone_number,
  content,
  verification_code,
  source,
  timestamp
FROM messages
WHERE verification_code IS NOT NULL
ORDER BY timestamp DESC
LIMIT 50;
```

### 2. Verification Code Success Rate by Carrier
```sql
SELECT 
  p.carrier,
  COUNT(m.id) as total_messages,
  COUNT(m.verification_code) as codes_found,
  ROUND(COUNT(m.verification_code) * 100.0 / COUNT(m.id), 2) as success_rate
FROM messages m
JOIN phones p ON m.phone_id = p.id
WHERE m.type = 'received'
GROUP BY p.carrier
ORDER BY success_rate DESC;
```

## User Activity Queries

### 1. User Login History
```sql
SELECT * FROM users
ORDER BY last_login DESC
LIMIT 10;
```

### 2. User Activity Summary
```sql
SELECT 
  provider,
  COUNT(*) as user_count,
  COUNT(CASE WHEN DATE(last_login) = DATE('now') THEN 1 END) as active_today
FROM users
GROUP BY provider;
```

## Maintenance Queries

### 1. Database Size Check
```sql
SELECT 
  'messages' as table_name,
  COUNT(*) as row_count,
  ROUND(SUM(LENGTH(content) + LENGTH(id) + LENGTH(phone_id)) / 1024.0 / 1024.0, 2) as approx_size_mb
FROM messages
UNION ALL
SELECT 
  'phones' as table_name,
  COUNT(*) as row_count,
  0 as approx_size_mb
FROM phones;
```

### 2. Clean Old Messages
```sql
-- Delete messages older than 30 days
DELETE FROM messages 
WHERE timestamp < datetime('now', '-30 days');

-- Keep only last 1000 messages per phone
DELETE FROM messages 
WHERE id NOT IN (
  SELECT id FROM (
    SELECT id, ROW_NUMBER() OVER (PARTITION BY phone_id ORDER BY timestamp DESC) as rn
    FROM messages
  ) WHERE rn <= 1000
);
```

### 3. Find Duplicate Messages
```sql
SELECT 
  content,
  phone_id,
  COUNT(*) as duplicate_count
FROM messages
GROUP BY content, phone_id
HAVING COUNT(*) > 1
ORDER BY duplicate_count DESC;
```

## Performance Optimization Queries

### 1. Analyze Query Performance
```sql
EXPLAIN QUERY PLAN
SELECT m.*, p.country, p.flag
FROM messages m
JOIN phones p ON m.phone_id = p.id
WHERE m.timestamp > datetime('now', '-1 day')
ORDER BY m.timestamp DESC;
```

### 2. Index Usage Statistics
```sql
-- Check if indexes are being used effectively
SELECT 
  name,
  tbl_name,
  sql
FROM sqlite_master
WHERE type = 'index';
```

## Real-time Dashboard Queries

### 1. Get Latest Activity Feed
```sql
SELECT 
  'message' as type,
  m.id,
  m.timestamp,
  m.content,
  p.number as phone_number,
  p.country
FROM messages m
JOIN phones p ON m.phone_id = p.id
WHERE m.timestamp > datetime('now', '-1 hour')
ORDER BY m.timestamp DESC
LIMIT 20;
```

### 2. Monitor Phone Status Changes
```sql
SELECT 
  id,
  number,
  country,
  status,
  signal,
  updated_at,
  CASE 
    WHEN updated_at < datetime('now', '-5 minutes') THEN 'stale'
    ELSE 'fresh'
  END as data_freshness
FROM phones
WHERE status = 'online'
ORDER BY signal DESC;
```