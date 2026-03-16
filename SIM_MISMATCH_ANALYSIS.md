# SIM Mismatch Analysis - 9 "Offline" SIMs

## Root Cause: Physical SIM Cards Don't Match Inventory

All 9 SIMs showing as "offline" are actually **physically present and working**, but they have the **wrong SIM cards installed** in those slots.

## The Problem

Your system is **SIM-centric** (by design from migration 031):
- `sims` table = inventory (what SHOULD be in each slot)
- `modems` table = reality (what daemon detects)
- `device_view` = joins by ICCID matching
- **If ICCID doesn't match → status = "inactive"**

## Detailed Comparison

### SIM #14
- **Expected** (inventory): ICCID `89860118803426385081`, IMEI `865827078379005`
- **Actual** (daemon): ICCID `89860000191897457594`, IMEI `865827078383312`
- **Status**: Modem with IMEI `865827078379005` has NO SIM (`current_iccid = NULL`)
- **Conclusion**: Physical slot 14 has a different SIM card (belongs to inventory slot 22)

### SIM #19
- **Expected** (inventory): ICCID `89860117801718603428`, IMEI `865827078377009`
- **Actual** (daemon): ICCID `8965012306052576256`, IMEI `865827078942505`
- **Status**: Modem with IMEI `865827078377009` has NO SIM
- **Conclusion**: Physical slot 19 has wrong SIM card

### SIM #46
- **Expected** (inventory): ICCID `898600110122F0072003`, IMEI `865827078941697`
- **Actual** (daemon): ICCID `8965012306052989640`, IMEI `865827079088241`
- **Status**: Modem with IMEI `865827078941697` has NO SIM
- **Conclusion**: Physical slot 46 has wrong SIM card

### SIM #57
- **Expected** (inventory): ICCID `89860322640105012814`, IMEI `865827078941945`
- **Actual** (daemon): ICCID `89860122802142937476`, IMEI `865827078401924`
- **Status**: Modem with IMEI `865827078941945` has NO SIM
- **Conclusion**: Physical slot 57 has wrong SIM card

### SIM #62
- **Expected** (inventory): ICCID `898600310123F0100634`, IMEI `865827078940863`
- **Actual** (daemon): ICCID `898600110122F0070826`, IMEI `865827078941275`
- **Status**: Modem with IMEI `865827078940863` has NO SIM
- **Conclusion**: Physical slot 62 has wrong SIM card

### SIM #63
- **Expected** (inventory): ICCID `89860121507480069235`, IMEI `865827079000600`
- **Actual** (daemon): Not detected in recent logs
- **Status**: Modem with IMEI `865827079000600` has NO SIM
- **Conclusion**: Physical slot 63 has no SIM or modem not detected

### SIM #71
- **Expected** (inventory): ICCID `89860324247522003117`, IMEI `865827078962834`
- **Actual** (daemon): ICCID `89860122801362457413`, IMEI `865827078895711`
- **Status**: Modem with IMEI `865827078962834` has NO SIM
- **Conclusion**: Physical slot 71 has wrong SIM card

### SIM #73
- **Expected** (inventory): ICCID `8965030124051507851`, IMEI `865827078906716`
- **Actual** (daemon): ICCID `8965012306052580191`, IMEI `865827079073235`
- **Status**: Modem with IMEI `865827078906716` has NO SIM
- **Conclusion**: Physical slot 73 has wrong SIM card

### SIM #91
- **Expected** (inventory): ICCID `8965012306052989657`, IMEI `865827078973062`
- **Actual** (daemon): Not detected in recent logs
- **Status**: Modem with IMEI `865827078973062` has NO SIM
- **Conclusion**: Physical slot 91 has no SIM or modem not detected

## Pattern Analysis

**8 out of 9 SIMs**: Physical modem exists, SIM card present, but WRONG ICCID installed
- Slots 14, 19, 46, 57, 62, 71, 73 have SIM cards but wrong ones
- The SIM cards in these slots belong to OTHER inventory positions

**1 out of 9 SIMs**: Modem exists but might be missing entirely from USB
- Slot 91 (and possibly 63) - need to check if modem is USB-detected

## Why This Happened

Most likely scenarios:
1. **Manual SIM swapping** - Someone physically moved SIM cards between modems
2. **Inventory import mismatch** - CSV import assigned wrong IMEI→ICCID mappings
3. **Initial installation error** - SIMs installed in wrong physical slots

## Solutions

### Option 1: Fix Inventory to Match Reality (Recommended)

**Update `sims` table to reflect actual SIM locations detected by daemon.**

This requires:
1. Query all 95 modems to get actual ICCID→IMEI mappings
2. Reverse-lookup each ICCID to find which `sim_index` it belongs to
3. Update `sims.imei` to match the modem that currently holds that ICCID

**Pros:**
- No physical access needed
- Instant fix
- System shows correct status immediately

**Cons:**
- Physical labels no longer match inventory
- Need to relabel modems if physical labels exist

### Option 2: Fix Physical Installation

**Remove and re-install SIM cards to match inventory.**

For each mismatch:
1. Remove SIM from physical slot
2. Find the correct SIM card (by ICCID from inventory)
3. Install in correct modem (by IMEI from inventory)
4. Restart daemon

**Pros:**
- Inventory matches physical reality
- Physical labels match database

**Cons:**
- Requires physical access to Orange Pi
- Time-consuming for 8+ SIM swaps
- Risk of breaking something during removal

### Option 3: Hybrid Approach

**Accept reality for working modems, fix only broken ones.**

- For 8 working SIMs (wrong location but functional): Update inventory
- For 1-2 non-working SIMs (#63, #91): Physical investigation

## Recommended Fix: Update Inventory Script

Create a script to auto-sync inventory with reality:

```sql
-- Step 1: Create temp mapping of actual ICCID → IMEI from modems table
CREATE TEMP TABLE actual_mapping AS
SELECT current_iccid AS iccid, equipment_id AS imei
FROM modems
WHERE current_iccid IS NOT NULL;

-- Step 2: Update sims.imei to match the modem that currently has each SIM
UPDATE sims
SET imei = (SELECT imei FROM actual_mapping WHERE actual_mapping.iccid = sims.iccid)
WHERE iccid IN (SELECT iccid FROM actual_mapping);

-- Step 3: Verify the fix
SELECT COUNT(*) as synced_sims FROM sims WHERE imei IN (SELECT equipment_id FROM modems WHERE current_iccid = sims.iccid);
```

**This will:**
- Make SIM #14-#73 show as "active" (matched to their actual modems)
- Preserve phone numbers and other metadata
- Only change the `imei` field (which modem has which SIM)

## Next Steps

1. **Verify remaining "inactive" SIMs** - Check if they're all mismatches or truly missing
2. **Run inventory sync script** - Update `sims.imei` to match reality
3. **Verify in frontend** - All 8 SIMs should show as "active" after sync
4. **Document the change** - Note that physical slot numbers may not match `sim_index` anymore
