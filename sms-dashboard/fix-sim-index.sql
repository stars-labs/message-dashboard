-- Clear sim_index for all disconnected modems
-- This prevents duplicate index display when modems reconnect
-- Run with: npx wrangler d1 execute sms-dashboard --file=fix-sim-index.sql --remote

UPDATE sims 
SET sim_index = NULL
WHERE current_modem_id IN (
  SELECT equipment_id 
  FROM modems 
  WHERE status = 'disconnected'
);