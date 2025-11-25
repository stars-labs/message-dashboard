# Zig to Rust Migration Plan

## Current Status Analysis

### Rust Daemon (v1.0.1) - CURRENT
- ✅ Basic modem discovery and message collection
- ✅ D-Bus integration with mmcli fallback
- ✅ Async/await with tokio (4 worker threads)
- ✅ HTTP API client with reqwest
- ✅ Signal quality monitoring
- ✅ Device details extraction (IMEI, manufacturer, model, firmware)
- ✅ Timestamp parsing (ISO 8601 with timezone support)
- ⚠️  Simple batch processing (20 modems at a time)
- ❌ NO worker thread architecture
- ❌ NO SMS sending capability
- ❌ NO signal caching
- ❌ NO priority management
- ❌ NO message deduplication
- ❌ NO lock-free data structures
- ❌ NO device sync manager
- ❌ NO retry manager

### Zig Daemon (v3.9.0) - REFERENCE
- ✅ Lock-free MPMC queue architecture
- ✅ 8-worker thread pool for parallel processing
- ✅ Lock-free signal cache (256 entries, hash-based)
- ✅ Lock-free priority manager (High/Medium/Low)
- ✅ Message tracker with Bloom filter deduplication
- ✅ 4 dedicated worker threads:
  - Message processor (upload queue)
  - Device status updater (with sync manager)
  - Signal monitor (periodic checks)
  - SMS sender (outgoing messages)
- ✅ BusctlDBus wrapper (90% reduction in subprocess calls)
- ✅ Adaptive timing (10ms target cycle time)
- ✅ Queue health monitoring and recovery
- ✅ Periodic SMS storage cleanup
- ✅ Systemd watchdog support
- ✅ Modem cache with 30s refresh
- ✅ Sync manager with full/incremental modes
- ✅ Retry manager with exponential backoff

---

## Stage 1: Core Infrastructure
**Goal**: Implement multi-threaded worker architecture
**Success Criteria**:
- 4 dedicated worker threads running
- Lock-free message queue working
- Shared state properly synchronized

**Implementation**:
1. Create lock-free message queue module
   - MPMC queue using crossbeam or lockfree crate
   - Message batching support
2. Create worker thread structure
   - Message processor thread
   - Device status thread
   - Signal monitor thread
   - SMS sender thread
3. Add shared context with Arc/Mutex where needed
4. Implement graceful shutdown signaling

**Tests**:
- [ ] All 4 threads start and run
- [ ] Messages flow through queue
- [ ] Threads respond to shutdown signal
- [ ] No deadlocks or panics

**Status**: Not Started

---

## Stage 2: Lock-Free Data Structures
**Goal**: Port lock-free caches and priority management
**Success Criteria**:
- Signal cache operational
- Priority manager working
- Performance matches or exceeds Zig version

**Implementation**:
1. Signal cache module
   - Hash-based cache (256 entries)
   - Linear probing for collisions
   - Atomic operations for thread safety
2. Priority manager module
   - High/Medium/Low priority tracking
   - Modem priority updates
   - Adaptive modem selection
3. Message deduplication
   - Bloom filter or HashSet-based
   - Prevent duplicate uploads

**Tests**:
- [ ] Signal cache stores/retrieves correctly
- [ ] Priority manager selects modems properly
- [ ] No duplicate messages uploaded
- [ ] Concurrent access works safely

**Status**: Not Started

---

## Stage 3: Advanced Features
**Goal**: Add SMS sending, sync manager, and retry logic
**Success Criteria**:
- Outgoing SMS working
- Sync manager tracks state
- Retry logic handles failures

**Implementation**:
1. SMS sender module
   - Poll API for pending SMS
   - Send via mmcli
   - Update API with results
2. Sync manager module
   - Full/incremental sync tracking
   - Checkpoint creation
   - Validation logic
3. Retry manager module
   - Exponential backoff
   - Max retry limits
   - Network error handling
4. Device collector module
   - Collect modem/SIM data
   - Parallel processing support

**Tests**:
- [ ] SMS sent successfully
- [ ] Sync modes work correctly
- [ ] Retries handle failures
- [ ] Device data collected properly

**Status**: Not Started

---

## Stage 4: Performance Optimization
**Goal**: Achieve Zig-level performance (10ms cycle time)
**Success Criteria**:
- 10ms target cycle time
- 87+ modems processed efficiently
- <10MB memory usage

**Implementation**:
1. Worker pool optimization
   - Batch size tuning
   - Queue size monitoring
   - Adaptive timing
2. D-Bus optimization
   - Reduce subprocess spawning
   - Connection pooling
   - Caching where possible
3. Memory optimization
   - Minimize allocations
   - Efficient string handling
   - Arena allocators where appropriate
4. Monitoring and metrics
   - Cycle time tracking
   - Queue health checks
   - Performance logging

**Tests**:
- [ ] Cycle time ≤ 10ms average
- [ ] Memory usage ≤ 10MB
- [ ] 87 modems process smoothly
- [ ] No performance regressions

**Status**: Not Started

---

## Stage 5: Production Hardening
**Goal**: Make daemon production-ready
**Success Criteria**:
- Zero crashes in 24h test
- Proper error recovery
- Clean deployment

**Implementation**:
1. Error handling improvements
   - Comprehensive error types
   - Graceful degradation
   - Error reporting
2. Recovery mechanisms
   - Queue overflow recovery
   - Modem error handling
   - Network failure recovery
3. Systemd integration
   - Watchdog support
   - Status notifications
   - Service configuration
4. Logging and debugging
   - Structured logging
   - Debug levels
   - Performance metrics
5. NixOS deployment
   - Update flake configuration
   - Remove Zig daemon references
   - Deploy and verify

**Tests**:
- [ ] 24h stability test passes
- [ ] All error paths tested
- [ ] Systemd integration works
- [ ] NixOS deployment successful

**Status**: Not Started

---

## Migration Strategy

### Phase 1: Development (Stages 1-2)
- Work in `orange-pi-daemon-rust/` directory
- Keep Zig daemon running in production
- Test locally with subset of modems

### Phase 2: Feature Parity (Stages 3-4)
- Complete all Zig features
- Performance benchmarking
- Side-by-side comparison

### Phase 3: Production Migration (Stage 5)
- Deploy Rust daemon to production
- Monitor for 24 hours
- Keep Zig daemon as backup
- Once stable, remove Zig code

### Rollback Plan
If Rust daemon fails:
1. Switch back to Zig daemon via systemd
2. Investigate issues
3. Fix and redeploy
4. Keep both daemons until confident

---

## Success Metrics

### Functional Requirements
- [ ] All 87 modems detected and processed
- [ ] Messages received and uploaded
- [ ] SMS sending works
- [ ] Signal monitoring active
- [ ] Device status updates working

### Performance Requirements
- [ ] Cycle time ≤ 10ms (target: match Zig)
- [ ] Memory usage ≤ 10MB
- [ ] CPU usage ≤ 20% (8-core CPU)
- [ ] Zero crashes in 24h

### Code Quality
- [ ] No unsafe code (except where absolutely necessary)
- [ ] Comprehensive error handling
- [ ] Unit tests for critical paths
- [ ] Documentation for complex logic

---

## Dependencies to Add

```toml
# Cargo.toml additions
crossbeam = "0.8"           # Lock-free data structures
dashmap = "5"                # Concurrent HashMap
parking_lot = "0.12"         # Better mutexes
bloomfilter = "1"            # Message deduplication
metrics = "0.21"             # Performance monitoring
```

---

## Risk Assessment

### High Risk
- **Lock-free implementation bugs**: Test thoroughly with multiple modems
- **Race conditions**: Use proper synchronization primitives
- **Memory leaks**: Monitor with valgrind/memory profiler

### Medium Risk
- **Performance regression**: Benchmark continuously
- **D-Bus integration issues**: Keep mmcli fallback working
- **SMS sending reliability**: Test with real modems

### Low Risk
- **Deployment issues**: NixOS configuration well-understood
- **API compatibility**: Already working in v1.0.1
