-- Delete messages with wrong timezone (8 hours ahead)
DELETE FROM messages 
WHERE id IN (
  SELECT m2.id
  FROM messages m1
  JOIN messages m2 ON 
    m1.phone_iccid = m2.phone_iccid AND
    m1.content = m2.content AND
    -- m2 timestamp is 8 hours ahead of m1
    datetime(m1.timestamp, '+8 hours') = datetime(m2.timestamp)
  WHERE m1.id < m2.id  -- Keep the older entry (likely the correct one)
);

-- Show remaining messages
SELECT id, phone_iccid, content, timestamp
FROM messages
WHERE content IN ('777777', '454545', '737377484')
ORDER BY timestamp DESC;