-- Delete duplicate messages keeping only the first one per content/phone
DELETE FROM messages 
WHERE id IN (
  SELECT id FROM (
    SELECT 
      m.id,
      ROW_NUMBER() OVER (
        PARTITION BY m.phone_iccid, m.content 
        ORDER BY 
          -- Prefer messages with proper timestamps
          CASE 
            WHEN m.timestamp LIKE '%+%' THEN 2
            WHEN LENGTH(REPLACE(m.timestamp, ' ', '')) != LENGTH(m.timestamp) THEN 1
            ELSE 0
          END,
          m.timestamp,
          m.id
      ) as rn
    FROM messages m
    WHERE m.content IN ('777777', '454545')
  ) t
  WHERE rn > 1
);

-- Show remaining messages
SELECT id, phone_iccid, phone_number, content, timestamp
FROM messages
ORDER BY timestamp DESC;