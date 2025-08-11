# Queue Management Fix - v3.7.0

## Problem Summary

The SMS daemon was experiencing:
1. Queue growing from 54 to 8000+ items causing memory corruption
2. Segmentation faults after running for ~6 minutes  
3. Workers unable to keep up with producer (main thread)

## Root Cause Analysis

### Producer-Consumer Imbalance
- **Main thread**: Submits 54 work items every 50ms
- **Workers**: Take 100-150ms to process 54 items
- **Result**: Queue grows by ~54 items every cycle because workers can't keep up

### Timeline of Events
1. Cycle 1: Submit 54 items → Workers start processing
2. Cycle 2 (50ms later): Workers still processing, submit 54 more items → Queue: 108
3. Cycle 3 (100ms): Workers finishing first batch, submit 54 more → Queue: 150+
4. Eventually: Queue grows to 8000+ items → Memory corruption → Segfault

## Solution Implementation

### 1. Skip Cycles When Busy (`main.zig`)
```zig
// Check if worker pool is still busy from previous cycle
const initial_queue_size = worker_pool.queueSize();
if (initial_queue_size > modems_to_check.len) {
    std.log.warn("⚠️ Worker pool still processing {d} items from previous cycle, skipping this cycle", .{initial_queue_size});
    // Skip this cycle to let workers catch up
    std.time.sleep(50 * std.time.ns_per_ms);
    continue;
}
```
**Effect**: Prevents submitting new work when workers are still busy

### 2. Improved Worker Retry Logic (`worker_pool.zig`)
```zig
const max_retries = 10; // Increased from 5
// Progressive backoff:
// - First 3 attempts: CPU spin hints
// - Next 3 attempts: 10-100μs sleeps  
// - Final attempts: 500μs sleeps
```
**Effect**: Higher success rate popping items from queue

### 3. Removed Aggressive Draining
- Previous: Tried to drain excess items when queue > 2x modem count
- Problem: Draining created more work and confusion
- Solution: Simply wait for workers to process naturally

### 4. Better Timeouts
```zig
const max_wait_ms: i64 = @max(50, @min(200, modems_to_check.len * 3));
```
**Effect**: More time for workers to complete before next cycle

## Expected Behavior After Fix

1. **Queue Size**: Should stay around 0-54 items (never exceed 108)
2. **Cycle Skipping**: Main thread skips cycles when workers are busy
3. **No Segfaults**: Queue never grows large enough to cause corruption
4. **Stable Operation**: Daemon runs continuously without crashes

## Performance Impact

- **Before**: 50ms cycles regardless of worker status → queue overflow
- **After**: Adaptive cycles that wait for workers → stable queue
- **Trade-off**: Slightly less frequent modem checks when busy, but no crashes

## Testing Results

✅ Queue stays bounded to ~54 items
✅ No segmentation faults
✅ Workers successfully process all items
✅ System automatically recovers from temporary slowdowns

## Deployment

```bash
cd /home/freeman.xiong/Documents/github/hecoinfo/message-dashboard/orange-pi-daemon
zig build -Doptimize=ReleaseFast -Dlog_level=info
sudo nixos-rebuild switch --flake .#orange-pi --target-host root@10.171.150.102 --build-host root@10.171.150.102 --impure
```

## Version History

- v3.4.0: Initial lock-free implementation
- v3.5.0: BusctlDBus integration
- v3.6.0: Code cleanup, fixed hash collisions
- v3.6.1: Added bounds checking to prevent segfaults
- v3.7.0: **Fixed producer-consumer imbalance** ← Current