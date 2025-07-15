-- Simple migration to clean up test data and ensure all phones have ICCID as ID
-- This doesn't change the schema, just ensures data consistency

-- Delete any test phones (SIM_X format)
DELETE FROM phones 
WHERE id LIKE 'SIM_%' 
AND (iccid IS NULL OR iccid = '');

-- Delete any phones without ICCID
DELETE FROM phones 
WHERE iccid IS NULL OR iccid = '';

-- Update phone IDs to use ICCID where they don't match
UPDATE phones 
SET id = iccid 
WHERE id != iccid 
AND iccid IS NOT NULL 
AND iccid != '';

-- Clean up any orphaned messages
DELETE FROM messages 
WHERE phone_id NOT IN (SELECT id FROM phones);

-- Ensure all future phones use ICCID as ID (application logic will handle this)