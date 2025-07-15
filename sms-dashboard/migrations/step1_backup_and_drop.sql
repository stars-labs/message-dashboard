-- Step 1: Create backup of current data
CREATE TABLE phones_backup AS SELECT * FROM phones;
CREATE TABLE messages_backup AS SELECT * FROM messages;

-- Step 2: Drop the original tables
DROP TABLE IF EXISTS messages;
DROP TABLE IF EXISTS phones;