-- Fix malformed timestamps in messages table
-- Pattern: "2025-11-02T19:52:4608" should be "2025-11-02T19:52:46.000Z"
-- The "08" at the end is the timezone offset that got concatenated

UPDATE messages
SET timestamp =
  CASE
    -- When timestamp ends with timezone offset (2 digits after seconds)
    WHEN LENGTH(timestamp) = 21 AND timestamp LIKE '____-__-__T__:__:____'
    THEN SUBSTR(timestamp, 1, 19) || '.000Z'

    -- Already correct format
    WHEN timestamp LIKE '____-__-__T__:__:__.___Z'
    THEN timestamp

    -- Default: try to extract first 19 chars and add .000Z
    ELSE SUBSTR(timestamp, 1, 19) || '.000Z'
  END
WHERE timestamp NOT LIKE '____-__-__T__:__:__.___Z';

-- Verify the fix
SELECT
  COUNT(*) as total,
  COUNT(CASE WHEN timestamp LIKE '____-__-__T__:__:__.___Z' THEN 1 END) as correct,
  COUNT(CASE WHEN timestamp NOT LIKE '____-__-__T__:__:__.___Z' THEN 1 END) as incorrect
FROM messages;