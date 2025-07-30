# Root Cause Analysis: mmcli Core Dumps

## Problem
mmcli was producing core dumps continuously when the daemon was running, even with error handling in place.

## Root Cause
**Concurrent access to ModemManager causes mmcli to crash.**

When the daemon spawned 24 threads that all tried to execute mmcli commands simultaneously, it overwhelmed ModemManager or triggered race conditions within mmcli/ModemManager, leading to segmentation faults.

## Evidence
1. Crashes only occurred when the daemon was running (not during manual mmcli commands)
2. Multiple threads were all trying to access modems at the same time
3. Core dumps happened immediately after thread spawn (within 1 second)
4. ModemManager is not designed to handle 24+ concurrent mmcli requests

## Solution
Changed from parallel thread processing to sequential processing for modem operations that involve mmcli calls.

### Before (v1.5.0 and earlier)
```zig
// Spawn threads for all modems
for (modems) |modem_id| {
    const thread = std.Thread.spawn(.{}, processModem, .{context});
    threads.append(thread);
}
// All threads run mmcli commands simultaneously = CRASH
```

### After (v1.5.1)
```zig
// Process modems sequentially
for (modems) |modem_id| {
    ModemThreadContext.processModem(context);
}
// Only one mmcli command runs at a time = NO CRASH
```

## Performance Impact
- Phone status updates take slightly longer (sequential vs parallel)
- With 24 modems, update time increases from ~2 seconds to ~5-10 seconds
- Message checking is unaffected (still runs every 1 second)
- Signal checks are unaffected (still cached)

## Future Improvements
1. Implement a connection pool with limited concurrency (e.g., 4 threads max)
2. Use ModemManager's D-Bus API directly instead of mmcli
3. Add timing metrics to track actual performance impact
4. Consider using async I/O instead of threads

## Lessons Learned
1. System tools like mmcli may not be thread-safe
2. Always test with production-scale loads (24 modems, not just 2-3)
3. Core dumps indicate system-level issues, not just application errors
4. Sequential processing is sometimes better than parallel for system resources