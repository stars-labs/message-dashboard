-- Delete duplicate messages with content 545454
DELETE FROM messages 
WHERE id IN (
  SELECT id FROM (
    SELECT 
      id,
      ROW_NUMBER() OVER (PARTITION BY phone_iccid, content ORDER BY 
        CASE 
          WHEN timestamp LIKE '%+%' THEN 2  -- Corrupted timestamps last
          WHEN CAST(substr(timestamp, 12, 2) AS INTEGER) > 15 THEN 1  -- Wrong timezone
          ELSE 0  -- Good timestamps first
        END,
        id
      ) as rn
    FROM messages 
    WHERE content = '545454'
  )
  WHERE rn > 1
);

-- Fix timestamps that are 8 hours ahead (Beijing time treated as UTC)
UPDATE messages 
SET timestamp = datetime(timestamp, '-8 hours') || 'Z'
WHERE timestamp > datetime('now') 
   OR CAST(substr(timestamp, 12, 2) AS INTEGER) >= 16;  -- Hour >= 16 suggests Beijing time

-- Show remaining messages
SELECT id, phone_iccid, content, timestamp 
FROM messages 
WHERE content IN ('777777', '545454')
ORDER BY timestamp DESC;