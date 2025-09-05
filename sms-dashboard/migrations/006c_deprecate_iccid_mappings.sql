-- Migration 006c: Deprecate iccid_mappings table
-- Date: 2025-09-05
-- Purpose: Step 3 - Handle redundant iccid_mappings table

-- Check if there's any unique data in iccid_mappings
SELECT 'Checking for unique data in iccid_mappings...' as status;

-- Count mappings with different data than sims table
SELECT COUNT(*) as unique_mappings
FROM iccid_mappings im
LEFT JOIN sims s ON im.iccid = s.iccid
WHERE im.is_active = 1
  AND (
    (im.phone_number IS NOT NULL AND im.phone_number != s.phone_number) OR
    (im.carrier IS NOT NULL AND im.carrier != s.carrier) OR
    (im.country IS NOT NULL AND im.country != s.country_code)
  );

-- Update sims table with any unique mapping data (if exists)
UPDATE sims 
SET 
    phone_number = COALESCE(
        (SELECT phone_number 
         FROM iccid_mappings 
         WHERE iccid = sims.iccid 
           AND is_active = 1 
           AND phone_number IS NOT NULL),
        sims.phone_number
    )
WHERE iccid IN (
    SELECT iccid 
    FROM iccid_mappings 
    WHERE is_active = 1 
      AND phone_number IS NOT NULL
);

-- Rename iccid_mappings table to deprecated
ALTER TABLE iccid_mappings RENAME TO iccid_mappings_deprecated;

SELECT 'iccid_mappings table deprecated. Data preserved in iccid_mappings_deprecated' as status;