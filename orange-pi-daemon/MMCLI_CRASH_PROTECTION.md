# MMCLI Crash Protection

## Problem
When running at high frequencies (10 Hz), mmcli was crashing with core dumps when trying to access modems without SIM cards or problematic modems. This was causing system instability and filling up logs with core dump messages.

## Solution Implemented

### 1. Problematic Modem Tracking
- Added `problematic_modems` hashmap to ModemManager to track modems that cause crashes
- Modems are automatically added to this list when:
  - mmcli crashes (non-Exited termination)
  - mmcli returns non-zero exit code
  - Child.run() throws an error

### 2. Enhanced Error Handling
- All mmcli calls now have proper error handling with catch blocks
- Process termination status is checked before using results
- Graceful fallback when mmcli fails (returns null or empty arrays)

### 3. Skip Logic
- Problematic modems are skipped entirely in subsequent operations
- Both `getIccid()` and `getNewMessages()` check the problematic list first
- Main loop also checks problematic modems before processing

### 4. Safer Default Frequency
- Changed default message check interval from 100ms (10 Hz) to 1000ms (1 Hz)
- This reduces the stress on mmcli and the system
- Users can still configure higher frequencies if their hardware supports it

## Configuration Recommendations

### Safe Configuration (Default)
```nix
messageCheckIntervalMs = 1000;  # 1 Hz - check once per second
```

### Moderate Risk
```nix
messageCheckIntervalMs = 500;   # 2 Hz - check twice per second
```

### High Risk (Not Recommended)
```nix
messageCheckIntervalMs = 100;   # 10 Hz - may cause crashes
```

## Monitoring

To check if modems are being marked as problematic, look for these log messages:
- "Failed to run mmcli for modem {s}"
- "mmcli crashed for modem {s}"
- "mmcli exited with code {d} for modem {s}"

## Future Improvements

1. Periodic retry of problematic modems (e.g., every 5 minutes)
2. Persist problematic modem list across daemon restarts
3. Different handling for temporary vs permanent failures
4. Implement exponential backoff for failing modems