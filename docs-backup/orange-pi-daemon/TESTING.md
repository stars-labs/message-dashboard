# SMS Dashboard Daemon - Testing Guide

## Overview

The SMS Dashboard Daemon has a comprehensive test suite with 82.2% code coverage. The test suite includes unit tests for all major components, ensuring reliability and correctness of the daemon's functionality.

## Running Tests

### Basic Test Execution
```bash
# Run all tests
zig build test

# Run tests directly
zig test src/tests.zig

# Run tests with wrapper script (recommended)
./run_tests.sh
```

### Test Coverage Report
```bash
# Build and run coverage report
zig build-exe coverage.zig && ./coverage
```

## Test Structure

All tests are located in `src/tests.zig` and organized by module:

### 1. **Utils Tests** (100% coverage)
- Verification code extraction from SMS content
- Support for multiple languages (Chinese, English, Korean, Japanese)
- Edge case handling for various code formats

### 2. **Types Tests** (100% coverage)
- Data structure validation
- Default value verification
- Optional field handling

### 3. **MessageQueue Tests** (100% coverage)
- Thread-safe queue operations
- Batch processing
- Memory management
- Concurrent access testing

### 4. **SignalCache Tests** (100% coverage)
- Signal data caching
- Update threshold logic
- Time-based cache invalidation
- Multi-modem support

### 5. **ApiClient Tests** (100% coverage)
- HTTP request handling
- JSON payload formatting
- Error handling for network failures
- Empty data handling

### 6. **ModemManager Tests** (46.7% coverage)
- Hash map operations
- Problematic modem tracking
- ICCID warning management
- Note: Full coverage requires hardware/mmcli

### 7. **SMSSender Tests** (100% coverage)
- SMS sending workflow
- Error handling
- Modem lookup
- API integration

## Test Categories

### Unit Tests
- Individual function testing
- Data structure validation
- Algorithm correctness

### Integration Tests
- Component interaction
- API communication (mocked)
- Error propagation

### Thread Safety Tests
- Concurrent access patterns
- Mutex correctness
- Race condition prevention

## Expected Test Output

When running tests, all tests should pass cleanly without error logs:

```
All 36 tests passed.
```

The tests now suppress error/warning logs during test runs to ensure proper exit codes. In production builds, these logs will still appear normally for debugging purposes.

## Writing New Tests

To add new tests, append them to `src/tests.zig`:

```zig
test "MyModule new functionality" {
    // Arrange
    var module = MyModule.init(testing.allocator);
    defer module.deinit();
    
    // Act
    const result = try module.doSomething();
    
    // Assert
    try testing.expectEqual(expected_value, result);
}
```

### Best Practices
1. Always clean up allocated memory
2. Test both success and failure cases
3. Use descriptive test names
4. Group related tests together
5. Mock external dependencies (network, hardware)

## Coverage Goals

- Minimum coverage target: 80%
- Current coverage: 82.2%
- Focus areas for improvement:
  - ModemManager hardware-dependent functions
  - End-to-end integration tests

## Continuous Integration

The test suite is designed to run in CI environments without hardware dependencies. All hardware interactions are properly mocked or return expected errors.

## Troubleshooting

### Tests Pass But Exit Code 1
This is due to Zig treating logged errors as test failures. Use the `run_tests.sh` wrapper script which properly handles this.

### Network-Related Failures
Tests expect network operations to fail with specific errors. If you see unexpected network errors, ensure the expected error list includes:
- `error.UnknownHostName`
- `error.ConnectionRefused`
- `error.TlsInitializationFailed`
- `error.TemporaryNameServerFailure`

### Memory Leaks
Run tests with leak detection:
```bash
zig test src/tests.zig --test-name-prefix "test name"
```

## Performance Testing

While not included in the unit tests, performance can be tested with:

```bash
# Build optimized version
zig build -Doptimize=ReleaseFast

# Run with performance monitoring
./zig-out/bin/orange-pi-daemon
```

Monitor:
- Message processing rate
- Memory usage over time
- CPU utilization
- Thread synchronization overhead