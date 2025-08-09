-- Migration 007: Add sim_index field to sims table
-- The sim_index represents the SIM ID from mmcli (e.g., 12 from /org/freedesktop/ModemManager1/SIM/12)
-- This is important for hardware identification and debugging

-- Add sim_index field to sims table
ALTER TABLE sims ADD COLUMN sim_index INTEGER;

-- Create index for performance
CREATE INDEX IF NOT EXISTS idx_sims_sim_index ON sims(sim_index);

-- Comment: 
-- sim_index: The SIM ID from mmcli (e.g., /org/freedesktop/ModemManager1/SIM/12 -> 12)
-- This is a transient identifier that changes when modems are plugged/unplugged
-- but is useful for debugging hardware issues and tracking SIM cards during runtime