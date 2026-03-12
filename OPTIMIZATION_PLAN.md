# Orange Pi Daemon Optimization Plan

**Current State**: v8.0.0, ~5700 LOC Rust daemon managing 100+ USB modems
**Architecture**: Direct AT commands (1-5ms) with D-Bus fallback, Tokio async, 4-core ARM optimization

---

## Executive Summary

The daemon is already well-optimized for its domain (100+ modems on ARM hardware). Key strengths:
- Direct AT commands bypass ModemManager (1-5ms vs 50ms)
- Worker pool with 16 concurrent workers and smart batching (24 modems/batch)
- Signal cache (30s TTL, 256 entries) reduces redundant queries
- Dynamic batch uploader (10-100 messages) with exponential backoff
- Multipart SMS assembly with persistent SQLite buffering
- Tokio runtime tuned for 4-core ARM CPUs

**Optimization Focus**: Memory efficiency, network resilience, observability, and code maintainability.

---

## Stage 1: Memory & Resource Optimization (High Impact, Low Risk)

### 1.1 Signal Cache Memory Bounds
**Problem**: `SignalCache` HashMap can grow unbounded with 100+ modems
**Impact**: Potential memory bloat on constrained ARM hardware
**Solution**: Add LRU eviction with configurable max size

```rust
// signal_cache.rs
pub struct SignalCache {
    cache: Arc<RwLock<LruCache<String, CacheEntry>>>, // Use lru crate
    max_size: usize, // Default 256
}
```

**Effort**: 2-3 hours
**Testing**: Add test for cache eviction under load
**Success Criteria**: Memory stable at 256 entries, no OOM on long runs

### 1.2 Message Store Connection Pooling
**Problem**: Single `Arc<Mutex<Connection>>` serializes all DB operations
**Impact**: Contention during upload spikes (daemon reads 1000+ messages/min)
**Solution**: Use rusqlite with connection pool (r2d2)

```rust
// message_store.rs
pub struct MessageStore {
    pool: Arc<Pool<SqliteConnectionManager>>, // r2d2 pool
}
```

**Effort**: 4-5 hours (testing critical)
**Risk**: Medium (must preserve transactional semantics)
**Success Criteria**: 2-3x throughput improvement on message uploads

### 1.3 Port Cache Optimization
**Problem**: `port_cache: Arc<RwLock<HashMap<String, String>>>` rebuilt on every `list_modems()` call
**Impact**: Unnecessary write locks and allocations every second
**Solution**: Only rebuild cache on modem discovery changes

```rust
// modem_manager.rs
struct CacheState {
    ports: HashMap<String, String>,
    last_scan: Instant,
    scan_interval: Duration, // 60s
}
```

**Effort**: 2 hours
**Success Criteria**: 90% reduction in write lock contention

---

## Stage 2: Network Resilience (High Impact, Medium Risk)

### 2.1 Graceful API Degradation
**Problem**: Daemon relies on Cloudflare API; no local fallback for critical ops
**Impact**: Messages buffered indefinitely if API down >1hr
**Solution**: Add health check + export local endpoint for emergency reads

```rust
// api_client.rs
pub async fn health_check(&self) -> HealthStatus {
    // Exponential backoff from 1s to 60s
    // Expose /health endpoint on localhost:9090
}
```

**Effort**: 3-4 hours
**Testing**: Simulate API outage, verify local query endpoint works
**Success Criteria**: Daemon continues SMS reads during API outage

### 2.2 Smart Retry with Circuit Breaker
**Problem**: Exponential backoff waits up to 60s, but no circuit breaker
**Impact**: Hammering dead API wastes CPU and delays recovery detection
**Solution**: Implement circuit breaker pattern (open after 5 failures, half-open after 30s)

**Effort**: 3 hours
**Library**: `failsafe` crate
**Success Criteria**: Fast-fail during API outages, auto-recover when API returns

### 2.3 Batch Upload Size Auto-Tuning
**Problem**: Dynamic batch size (10-100) based on payload size, but no latency feedback
**Impact**: May send oversized batches causing Worker timeouts
**Solution**: Track API response times, reduce batch size on slow responses

```rust
// main.rs uploader task
let mut adaptive_batcher = AdaptiveBatcher::new(50);
adaptive_batcher.adjust_on_latency(response_time); // Shrink if >2s
```

**Effort**: 2-3 hours
**Success Criteria**: No Worker timeouts under load spikes

---

## Stage 3: Observability & Debugging (Medium Impact, Low Risk)

### 3.1 Structured Logging with Metrics
**Problem**: Text logs hard to parse; no Prometheus metrics
**Impact**: Debugging production issues requires log scraping
**Solution**: Add Prometheus exporter on localhost:9090/metrics

```rust
// Add prometheus crate
lazy_static! {
    static ref SMS_READ_COUNTER: IntCounter = register_int_counter!(...).unwrap();
    static ref UPLOAD_LATENCY: Histogram = register_histogram!(...).unwrap();
}
```

**Metrics to Track**:
- `sms_messages_read_total{modem_id}`
- `sms_upload_batch_size`
- `sms_upload_latency_seconds`
- `signal_cache_hit_rate`
- `worker_pool_utilization`

**Effort**: 4-5 hours
**Success Criteria**: Grafana dashboard shows real-time daemon health

### 3.2 Distributed Tracing
**Problem**: No visibility into cross-component latency (modem → DB → API)
**Impact**: Hard to pinpoint bottlenecks in message flow
**Solution**: Add OpenTelemetry spans

```rust
// Use tracing-opentelemetry crate
#[instrument(skip(modem_manager))]
async fn process_single_modem(...) {
    // Auto-generates spans with timing
}
```

**Effort**: 3-4 hours
**Success Criteria**: Jaeger shows end-to-end message flow timing

### 3.3 Health Check Endpoint
**Problem**: systemd only knows if process alive, not if modems stuck
**Impact**: Zombie daemon keeps running with zero throughput
**Solution**: HTTP health endpoint with detailed status

```http
GET localhost:9090/health
{
  "status": "healthy",
  "modems_active": 98,
  "messages_last_minute": 142,
  "upload_lag_seconds": 3.2,
  "signal_cache_hit_rate": 0.87
}
```

**Effort**: 2 hours
**Success Criteria**: Monitoring can detect stuck daemon

---

## Stage 4: Code Quality & Maintainability (Low Impact, Low Risk)

### 4.1 Remove Dead Code
**Warnings**:
- `probe_port()` never used
- `super::*` import in lib.rs

**Effort**: 30 min
**Run**: `cargo fix --lib`

### 4.2 Extract Configuration to File
**Problem**: Hardcoded config in main.rs (worker count, timeouts, batch sizes)
**Impact**: Requires recompile to tune parameters
**Solution**: TOML config file

```toml
# /etc/sms-daemon/config.toml
[worker_pool]
num_workers = 16
batch_size = 24
modem_timeout_secs = 12

[uploader]
initial_batch_size = 50
max_batch_size = 100

[signal_cache]
ttl_seconds = 30
max_entries = 256
```

**Effort**: 3-4 hours
**Success Criteria**: Can tune production without redeployment

### 4.3 Integration Test Suite
**Problem**: 62 unit tests, but no integration tests
**Impact**: AT command parser well-tested, but system interactions untested
**Solution**: Docker-based test environment with mock ModemManager

**Effort**: 8-10 hours (one-time investment)
**Success Criteria**: CI runs full integration suite on commits

### 4.4 Error Type Consolidation
**Problem**: Mix of `anyhow::Error` and `thiserror` custom errors
**Impact**: Inconsistent error handling patterns
**Solution**: Standardize on `thiserror` for library code

**Effort**: 2-3 hours
**Risk**: Low (mainly refactoring)

---

## Stage 5: Performance Enhancements (Medium Impact, High Risk)

### 5.1 Parallel Modem Discovery
**Problem**: `discover_modems()` scans 100+ ports serially (~10ms each = 1s total)
**Impact**: Startup delay, cache rebuild slowness
**Solution**: Parallel port probing with semaphore

```rust
// at_modem.rs
pub async fn discover_modems_parallel(&self) -> Result<Vec<String>> {
    let sem = Arc::new(Semaphore::new(16)); // 16 concurrent probes
    // Spawn task per port, acquire permit before probing
}
```

**Effort**: 3-4 hours
**Testing**: Verify correct port detection under load
**Success Criteria**: 5-10x faster discovery (1s → 100-200ms)

### 5.2 AT Command Pipelining
**Problem**: Serial AT commands to same modem (ICCID → IMEI → Signal → SMS)
**Impact**: Latency adds up (4 commands × 5ms = 20ms per modem)
**Solution**: Send multiple commands in pipeline, parse responses

**Effort**: 6-8 hours
**Risk**: HIGH (complex state machine, easy to break)
**Success Criteria**: 2x reduction in per-modem processing time

### 5.3 Zero-Copy PDU Parsing
**Problem**: PDU parsing allocates many temporary Strings
**Impact**: GC pressure on high-throughput scenarios
**Solution**: Use `&str` slices, only allocate final Message

**Effort**: 4-5 hours
**Risk**: Medium (careful lifetime management needed)
**Success Criteria**: 20-30% reduction in allocations (use `heaptrack`)

---

## Stage 6: Feature Additions (New Capabilities)

### 6.1 Modem Health Monitoring
**Current**: Health check exists but not used in main loop
**Solution**: Periodic health checks (every 5min), auto-restart unhealthy modems

**Effort**: 3-4 hours
**Success Criteria**: Detect and recover from stuck modems without manual intervention

### 6.2 SMS Sending Priority Queue
**Problem**: Outbound SMS processed FIFO
**Impact**: Urgent messages delayed behind bulk sends
**Solution**: Priority field in `pending_sms` table, heap-based queue

**Effort**: 4-5 hours
**Success Criteria**: High-priority SMS sent within 10s regardless of queue depth

### 6.3 Dynamic Worker Pool Scaling
**Problem**: Fixed 16 workers, regardless of load
**Impact**: Underutilization at night, potential overload during spikes
**Solution**: Scale workers 8-24 based on pending message count

**Effort**: 3-4 hours
**Success Criteria**: CPU usage drops 30% during idle periods

---

## Implementation Priority

### Phase 1 (Week 1-2): Quick Wins
1. Signal cache LRU bounds (1.1)
2. Remove dead code (4.1)
3. Health check endpoint (3.3)
4. Port cache optimization (1.3)

**Expected Impact**: 10-15% memory reduction, better monitoring

### Phase 2 (Week 3-4): Resilience
1. Circuit breaker for API (2.2)
2. Graceful API degradation (2.1)
3. Batch size auto-tuning (2.3)

**Expected Impact**: Zero data loss during API outages

### Phase 3 (Month 2): Observability
1. Prometheus metrics (3.1)
2. TOML configuration (4.2)
3. Distributed tracing (3.2)

**Expected Impact**: 50% faster incident diagnosis

### Phase 4 (Month 3): Performance (Optional)
1. Parallel modem discovery (5.1)
2. Connection pooling (1.2)
3. Modem health monitoring (6.1)

**Expected Impact**: 20-30% throughput improvement

### Phase 5 (Month 4+): Advanced (If Needed)
1. AT command pipelining (5.2)
2. Zero-copy PDU parsing (5.3)
3. Dynamic worker scaling (6.3)

**Expected Impact**: 2x message processing rate

---

## Risk Assessment

| Change | Risk | Mitigation |
|--------|------|-----------|
| Connection pooling | Medium | Feature flag, extensive testing |
| AT pipelining | High | Prototype first, modem-specific quirks |
| Circuit breaker | Low | Well-established pattern |
| Config externalization | Low | Fall back to defaults |
| Prometheus metrics | Low | Opt-in, no perf impact |

---

## Testing Strategy

### For Each Stage:
1. **Unit tests**: Cover new logic paths
2. **Benchmark**: Use `criterion` for perf-critical code
3. **Load test**: Simulate 100+ modems with mock responses
4. **Soak test**: Run 24h+ on staging Orange Pi
5. **Rollback plan**: Git tag before deployment, systemd restart on failure

### Key Metrics to Monitor:
- Message read rate (messages/sec)
- Upload success rate (%)
- API latency (p50, p99)
- Memory usage (RSS)
- CPU utilization (%)
- Signal cache hit rate (%)

---

## Non-Goals (Explicitly Out of Scope)

❌ **Rewrite in another language** — Rust is correct choice for this use case
❌ **Switch back to D-Bus** — AT commands are objectively faster
❌ **Add GUI** — Web dashboard already exists
❌ **Multi-host coordination** — Single Orange Pi sufficient for 100 modems
❌ **Real-time WebSocket** — Removed for cost optimization (intentional)

---

## Conclusion

The daemon is **production-ready** as-is. Optimizations are incremental improvements, not critical fixes.

**Recommended Next Steps**:
1. Start with Phase 1 (quick wins) to improve observability
2. Implement Phase 2 only if API reliability becomes an issue
3. Defer performance optimizations (Phase 4+) until evidence of bottleneck

**Effort Estimate**:
- Phase 1: 8-12 hours
- Phase 2: 10-15 hours
- Phase 3: 12-16 hours
- Phase 4: 16-24 hours
- Phase 5: 24-40 hours

**Total**: 70-107 hours for full implementation (2-3 months part-time)
