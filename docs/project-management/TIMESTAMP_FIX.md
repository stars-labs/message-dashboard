# Critical Timestamp Parsing Fix

**Date**: October 5, 2025  
**Version**: Rust Daemon v1.0.1  
**Severity**: Critical - Data Corruption Bug

## Problem

The Rust SMS daemon was generating malformed timestamps in the database, causing data integrity issues.

### Symptoms
- Database timestamps appeared as: `2025-10-05T19:05:4208`
- Expected format: `2025-10-05T19:05:42.080Z`
- API was rejecting messages with 400 Bad Request errors
- Messages uploaded but timestamps corrupted

### Example Error
```sql
SELECT timestamp FROM messages ORDER BY timestamp DESC LIMIT 5;
┌──────────────────────────┐
│ timestamp                │
├──────────────────────────┤
│ 2025-10-05T19:05:4208    │  ← WRONG!
│ 2025-10-05T18:14:4208    │  ← WRONG!
│ 2025-10-05T17:12:1008    │  ← WRONG!
└──────────────────────────┘
```

## Root Cause

### Incorrect Parsing Logic
In `orange-pi-daemon-rust/src/modem_manager.rs` (line 171-177):

```rust
// BUGGY CODE
} else if line.contains("timestamp:") {
    let ts_parts: Vec<&str> = line.splitn(2, ':').collect();
    if ts_parts.len() == 2 {
        timestamp = ts_parts[1].trim().to_string();
    }
}
```

### Why It Failed
The `splitn(2, ':')` method splits on the **first colon** only, but timestamps contain multiple colons:

```
Input:  "timestamp: 2025-10-05T14:23:45+08:00"
         ^^^^^^^^^^ ^^^^^^^^^^^^^^^^^^^^
         label      value with multiple colons

splitn(2, ':'): ["timestamp", " 2025-10-05T14"]
                                            ^^^ STOPS HERE!
Remaining: ":23:45+08:00" is lost
```

The daemon then concatenated parts incorrectly, creating strings like:
- `2025-10-05T14` + `23` + `45` + `08` = `2025-10-05T14234508`

## Solution

### Fixed Code
```rust
// CORRECT CODE
} else if line.contains("timestamp:") {
    // Extract everything after "timestamp:" (handle multiple colons)
    if let Some(idx) = line.find("timestamp:") {
        let ts_raw = &line[idx + 10..]; // Skip "timestamp:" (10 chars)
        timestamp = ts_raw.trim().to_string();
    }
}
```

### How It Works
1. Find the position of "timestamp:" in the string
2. Slice from that position + 10 characters (length of "timestamp:")
3. Trim whitespace to get the complete timestamp value
4. Preserves all colons and timezone information

## Testing

### Verification Steps
```bash
# 1. Build updated daemon
nix build .#orange-pi-daemon-rust

# 2. Deploy to Orange Pi
nixos-rebuild switch --flake .#orange-pi \
    --target-host root@203.116.95.146 \
    --build-host root@203.116.95.146 \
    --use-substitutes --impure

# 3. Monitor logs for correct timestamps
ssh root@203.116.95.146 "journalctl -efu sms-daemon.service" | grep timestamp

# 4. Check database
npx wrangler d1 execute sms-dashboard --remote \
    --command "SELECT timestamp FROM messages ORDER BY created_at DESC LIMIT 5"
```

### Expected Results
- Timestamps in format: `2025-10-05T14:23:45+08:00` or `2025-10-05T14:23:45.000Z`
- API accepts messages with 200 OK
- No 400 Bad Request errors in logs

## Impact Assessment

### Affected Data
- All messages collected by Rust daemon from initial deployment (Oct 4, 2025) until this fix
- Estimated ~1000+ messages with corrupted timestamps
- Messages still searchable by content and phone number
- Only timestamp field affected

### Data Recovery
Timestamps cannot be automatically recovered as original SMS timestamps are lost after deletion from modem.

**Recommendation**: 
- Accept corrupted timestamps as historical data
- Focus on correct timestamps going forward
- Consider adding timestamp validation in API as additional safeguard

## Prevention

### Added Safeguards
1. **API-side validation** (already exists in control.js):
   ```javascript
   // Server attempts to fix malformed timestamps
   const timeMatch = timestamp.match(/^(\d{4})-(\d{2})-(\d{2})[T\s]+(\d{1,2}):(\d{1,2}):(\d{1,2})(\.\d{3})?Z?$/);
   ```

2. **Unit tests** (recommended for future):
   ```rust
   #[test]
   fn test_timestamp_parsing() {
       let line = "timestamp: 2025-10-05T14:23:45+08:00";
       // Extract timestamp
       if let Some(idx) = line.find("timestamp:") {
           let timestamp = line[idx + 10..].trim();
           assert_eq!(timestamp, "2025-10-05T14:23:45+08:00");
       }
   }
   ```

## Related Issues

- **Zig Daemon Segfaults**: This bug only exists in Rust version; original Zig daemon had different parsing
- **API 500 Errors**: Separate issue with database transaction handling (see other reports)

## Deployment Status

- [x] Fix implemented in `modem_manager.rs`
- [x] Build verified with Nix
- [ ] Deployed to production
- [ ] Verified in production logs
- [ ] Database timestamps validated

## References

- File: `orange-pi-daemon-rust/src/modem_manager.rs` (lines 171-177)
- Commit: (pending)
- Related: API control handler timestamp normalization
