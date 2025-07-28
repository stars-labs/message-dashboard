-- Delete duplicate messages, keeping only the first one
DELETE FROM messages 
WHERE id IN (
  SELECT m2.id
  FROM messages m1
  JOIN messages m2 ON 
    m1.phone_iccid = m2.phone_iccid AND
    m1.content = m2.content AND
    m1.timestamp = m2.timestamp AND
    m1.id < m2.id
);

-- Delete messages with corrupted timestamps (containing +)
DELETE FROM messages 
WHERE timestamp LIKE '%+%';

-- Show results
SELECT 
  'Total messages' as metric, 
  COUNT(*) as count 
FROM messages

UNION ALL

SELECT 
  'Messages with content 777777' as metric,
  COUNT(*) as count 
FROM messages 
WHERE content = '777777';