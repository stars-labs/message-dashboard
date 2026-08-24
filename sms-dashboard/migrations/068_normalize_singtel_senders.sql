-- Canonicalize the two confirmed decimal-ASCII sender encodings already handled
-- by current daemon ingestion. Exact values only; ordinary numeric senders remain.

UPDATE messages
SET phone_number = CASE phone_number
    WHEN '83105110103116101108' THEN 'Singtel'
    WHEN '831051101031161011083266105122' THEN 'Singtel Biz'
END,
updated_at = CURRENT_TIMESTAMP
WHERE type = 'received'
  AND phone_number IN (
    '83105110103116101108',
    '831051101031161011083266105122'
  );
