# Changelog

All notable changes to the SMS Dashboard project.

## [1.0.1] - 2025-10-05

### Critical Fixes
- **Timestamp Parsing Bug**: Fixed malformed timestamps in database
  - Issue: Timestamps stored as `2025-10-05T19:05:4208` instead of `2025-10-05T19:05:42.080Z`
  - Root cause: Improved string parsing in modem_manager.rs
  - Impact: All new messages now have correct ISO 8601 timestamps
  - File: `orange-pi-daemon-rust/src/modem_manager.rs`

### Changed
- Refactored timestamp extraction to use string slicing instead of splitn
- More explicit and robust parsing logic
- Better handles edge cases in mmcli output

### Documentation
- Added comprehensive `TIMESTAMP_FIX.md` in docs/project-management/
- Created quick `DEPLOY.md` guide for deployment procedures
- Updated `CLAUDE.md` to reflect Rust daemon status

### Repository Cleanup
- Moved 19 project management docs from root to `docs/project-management/`
- Cleaner repository structure with only essential docs in root
- Better organization for long-term maintenance

---

## [1.0.0] - 2025-10-04

### Major Changes - Rust Daemon Migration
- **Complete rewrite from Zig to Rust** for better stability and memory safety
- Eliminated all segmentation faults that plagued Zig version (0xAAAAAAAAAAAAAAAABA errors)
- Async/await architecture with tokio runtime
- Direct mmcli integration via tokio::process::Command

### Added
- New Rust daemon in `orange-pi-daemon-rust/`
  - `src/main.rs` - Main event loop and coordination
  - `src/api_client.rs` - HTTP client for API communication
  - `src/modem_manager.rs` - ModemManager integration
  - `src/types.rs` - Data structures
- NixOS flake integration for Rust daemon
- Systemd service definition for production deployment

### Fixed
- Segmentation faults from Zig daemon (memory safety issues)
- Deadlocks in concurrent modem processing
- Unstable daemon crashes after 5-10 check cycles
- 500 Internal Server Errors from API rejections

### Performance
- Stable operation with 87 modems
- ~100 second check cycles
- Predictable memory usage (~50-60MB)
- No crashes or memory leaks

### Deprecated
- Zig daemon (`orange-pi-daemon/`) - kept for reference but no longer deployed
- Lock-free architecture from Zig (replaced with Rust's safe concurrency)

---

## [3.6.0] - 2025-08-XX (Zig Version - Final)

### Fixed
- Hash collision bug in LockFreeSignalCache
- Removed unused mutex from ApiClient
- Removed unused result queue system

### Changed
- Consolidated ModemCheckResult to types.zig
- Removed processModemParallel function
- ~200 lines of dead code removed

**Note**: This was the final Zig version before migration to Rust.

---

## [3.5.0] - 2025-08-XX

### Added
- BusctlDBus wrapper integration
- 90% reduction in subprocess spawning

### Performance
- Reduced mmcli calls from 200+/sec to ~20/sec
- busctl D-Bus direct commands
- Automatic fallback to mmcli if needed

---

## [3.4.0] - 2025-08-XX

### Added
- Complete lock-free architecture
- LockFreeMessageQueue for MPMC operations
- LockFreeSignalCache with atomic operations
- LockFreePriorityManager for modem scheduling

### Changed
- Eliminated ALL mutexes from hot paths
- 8-worker thread pool
- Bloom filter deduplication
- 50ms target cycle time

### Fixed
- All deadlock scenarios eliminated
- Improved stability with 54+ modems

---

## [2.1.0] - 2025-09-XX

### Added
- Database normalization to Third Normal Form (3NF)
- User override fields in `sims` table
- Foreign key constraints with referential integrity

### Changed
- Phone number overrides moved to `sims` table
- Removed `iccid_mappings` table (redundant)
- Removed redundant columns from `messages` table
- Optimized query performance

### Performance
- 79% database size reduction (5.31MB → 1.09MB)
- Query optimization (4.89k reads → single scan)
- Simplified JOIN operations

---

## [2.0.0] - 2025-08-XX

### Major Schema Changes
- Migrated from monolithic `phones` table to normalized structure
- New tables: `modems`, `sims`, `modem_state`, `daemon_health`
- Equipment ID (IMEI) as primary key for modems
- ICCID as primary key for SIMs
- `device_view` for backward compatibility

### Added
- Centralized table creation (`database-setup.js`)
- Device count utilities (`device-count.js`)
- Standardized API responses (`api-response.js`)
- D1 connection wrapper (`database-wrapper.js`)

### Fixed
- Memory leak in Zig daemon's getModemDetails()
- Transaction boundaries for multi-table updates
- Stale threshold checks (60s phantom, 120s offline)
- Equipment ID validation with synthetic fallback

### Performance
- Batch processing with D1 batch API
- Prepared statement caching
- Optimized indexes for common queries

---

## [1.16.0] - 2025-08-XX

### Added - Keyword System
- `keyword_tags` and `message_tags` tables
- `/api/keywords` CRUD endpoints
- `/api/messages/:id/tags` endpoint
- `/api/ai/analyze-keywords` AI analysis
- KeywordConfig.svelte UI component
- MessageHighlight.svelte with real-time highlighting

### Features
- Case-sensitive and whole-word matching options
- Priority-based keyword matching
- Custom colors for tags
- Usage statistics tracking
- Server-side keyword processing
- AI-powered keyword analysis

### Fixed
- Added `keywords.read` and `keywords.write` RBAC permissions
- Automatic table creation in API endpoints
- API client method calls (request() → get(), post(), etc.)

---

## Earlier Versions

For changes before v1.16.0, see git history or individual component changelogs:
- `sms-dashboard/CHANGELOG.md` (if exists)
- `orange-pi-daemon/CHANGELOG.md` (if exists)
- `orange-pi-daemon-rust/CHANGELOG.md` (this file)
