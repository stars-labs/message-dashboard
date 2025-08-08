SELECT COUNT(*) as total, 
       COUNT(CASE WHEN status IN ('online', 'active', 'registered') THEN 1 END) as online 
FROM phones 
WHERE iccid IS NOT NULL AND iccid != '';