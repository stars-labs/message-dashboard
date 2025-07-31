-- Add modem_index and sim_index fields to phones table
-- These help identify cards even when they're offline

-- Add the new columns
ALTER TABLE phones ADD COLUMN modem_index INTEGER;
ALTER TABLE phones ADD COLUMN sim_index INTEGER;

-- Create indices for better query performance
CREATE INDEX IF NOT EXISTS idx_phones_modem_index ON phones(modem_index);
CREATE INDEX IF NOT EXISTS idx_phones_sim_index ON phones(sim_index);

-- Add comment for clarity
-- modem_index: The modem ID from mmcli (e.g., /org/freedesktop/ModemManager1/Modem/7 -> 7)
-- sim_index: The SIM ID from mmcli (e.g., /org/freedesktop/ModemManager1/SIM/12 -> 12)