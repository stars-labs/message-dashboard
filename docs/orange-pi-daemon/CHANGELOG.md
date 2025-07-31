# Changelog

All notable changes to the SMS Dashboard Daemon will be documented in this file.

## [1.31.0] - 2025-07-30

### Fixed
- Fixed SMS content parsing to properly remove "|" prefix and leading spaces from continuation lines
  - Content like "|            吃吃" is now properly cleaned to just "吃吃"
  - Prevents mmcli formatting artifacts from being stored in the database

## [1.30.0] - 2025-07-30

### Fixed
- Fixed ISO timestamps without timezone being treated as UTC instead of Beijing time
  - Timestamps like "2025-07-30T20:32:14" are now correctly converted from Beijing time to UTC
  - Example: "2025-07-30T20:32:14" → "2025-07-30T12:32:14.000Z" (subtract 8 hours)
- Fixed UTF-8 validation incorrectly flagging valid Chinese characters as invalid
  - Removed flawed byte-by-byte validation that was treating UTF-8 start bytes (like 0xE5) as invalid
  - Now uses proper UTF-8 validation that correctly handles multi-byte sequences
- Fixed SMS content parsing to exclude formatting lines (dashes, equals, asterisks, underscores)
  - Messages like "午餐\n-----------------------" are now stored as just "午餐"
  - Prevents visual formatting from SMS output being stored as part of the message content

### Added
- Test case for Beijing time to UTC conversion (20:32 → 12:32)
- Test cases for formatting line exclusion in SMS content parsing

### Changed
- UTF-8 validation now uses Zig's built-in `utf8ValidateSlice` for proper validation
- SMS content parser now filters out lines consisting only of formatting characters

## [1.29.0] - 2025-07-30

### Fixed
- Fixed ISO format timestamps missing timezone indicator in JSON payloads
- Timestamps without timezone now get proper formatting:
  - Without milliseconds: "2025-07-30T20:16:36" → "2025-07-30T20:16:36.000Z"
  - With milliseconds: "2025-07-30T20:16:36.123" → "2025-07-30T20:16:36.123Z"
- This ensures consistent timestamp format and proper timezone interpretation by the server

### Added
- Unit test for ISO timestamp timezone handling

## [1.28.0] - 2025-07-30

### Fixed
- Fixed trailing 0xAA modem control byte causing messages to be encoded as byte arrays in JSON
- Improved content cleanup logic to specifically remove 0xAA and 0xFF bytes while preserving valid UTF-8
- Messages with Chinese content are now properly stored as readable text instead of byte arrays

### Added
- Unit test for verifying 0xAA byte cleanup in SMS content parsing
- Additional validation logging for content cleanup process

### Changed
- Content cleanup now checks for valid UTF-8 sequences to avoid removing legitimate UTF-8 continuation bytes

## [1.27.0] - 2025-07-30

### Fixed
- Fixed debug logging in production builds by implementing custom log function that respects LOG_LEVEL environment variable
- Updated systemd service configuration to ensure debug logs are visible in journal (added SyslogLevel=debug)
- Debug logs now properly appear in production when logLevel is set to "debug" in NixOS configuration

### Changed
- Log level can now be dynamically set via LOG_LEVEL environment variable (debug, info, warn, err)
- Systemd service explicitly sets journal output and syslog level for better log visibility

## [1.26.0] - 2025-07-30

### Fixed
- Fixed timezone conversion bug where timestamps without explicit timezone info were treated as UTC instead of Beijing time
- SMS timestamps from mmcli without timezone suffix are now assumed to be UTC+8 (Beijing time) and properly converted to UTC
- Example: 18:14:02 is now correctly converted to 10:14:02Z (subtract 8 hours)

### Changed
- Enabled debug logging in production to help diagnose message processing issues
- Added detailed logging for message content validation and timestamp processing

## [1.25.0] - 2025-07-30

### Fixed
- Fixed message content encoding issue where trailing non-UTF8 bytes (0xAA) from modems caused JSON encoder to serialize content as byte arrays
- SMS content is now cleaned up before JSON encoding, ensuring proper UTF-8 string serialization
- Messages will now be stored as readable text in the database instead of byte arrays

## [1.24.0] - 2025-07-30

### Fixed
- Fixed timezone conversion bug - timestamps from mmcli in Beijing time (UTC+8) are now properly converted to UTC
- SMS timestamps that were showing 8 hours ahead are now correctly adjusted (e.g., 10:25:46+08 becomes 02:25:46Z)

## [1.23.0] - 2025-07-30

### Added
- Comprehensive test suite with 36 unit tests
- Test coverage reporting (82.2% coverage achieved)
- Testing documentation (TESTING.md)
- Test runner wrapper script (run_tests.sh)
- Coverage analysis tool (coverage.zig)

### Fixed
- Multiline SMS content parsing bug - now correctly captures all lines of SMS messages
- Test runner exit code issue - tests now exit with code 0 when all pass
- Suppressed error logs during tests for proper CI/CD integration

### Changed
- Consolidated all tests into src/tests.zig for better organization
- Updated build.zig to support unified test execution
- Modified error logging to only occur in non-test builds

### Removed
- Cleaned up 7 redundant main_*.zig files
- Removed build artifacts from version control

## [1.22.0] - 2025-07-29

### Fixed
- SMS marking bug - correctly marks SMS as sent using proper API endpoint

## Previous versions...

### Added
- Initial implementation
- Multi-threaded architecture for parallel modem checking
- ModemManager integration via mmcli
- HTTP API client using native Zig HTTP
- Signal quality caching
- Message queue for batch processing
- NixOS module and flake support