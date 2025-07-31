# SMS Daemon Threading Architecture

## Overview

The SMS daemon uses a multi-threaded architecture to achieve high-frequency message checking while handling other operations asynchronously.

## Thread Design

### Main Thread - Message Scanner
- **Purpose**: Continuously scan all modems for new messages
- **Frequency**: As fast as possible (target: check each modem every 1-2 seconds)
- **Operations**:
  - Loop through all modems sequentially
  - For each modem:
    - Check if modem has SIM card (skip if not)
    - Get new messages via `mmcli --messaging-list-sms`
    - Queue messages for processing
  - No sleep between cycles
  - Only mmcli operations (no HTTP calls)

### Worker Thread 1 - Message Processor
- **Purpose**: Process and upload messages
- **Operations**:
  - Receive messages from queue
  - Parse message content
  - Upload to API via HTTP
  - Delete messages from modem after successful upload
  - Retry failed uploads

### Worker Thread 2 - Phone Status Updater
- **Purpose**: Update phone status periodically
- **Frequency**: Every 30 seconds
- **Operations**:
  - Get modem state
  - Get phone number
  - Get operator info
  - Get IMEI
  - Batch upload phone status

### Worker Thread 3 - Signal Monitor
- **Purpose**: Monitor signal quality
- **Frequency**: Every 60 seconds
- **Operations**:
  - Get signal quality for each modem
  - Cache signal data
  - Include in phone status updates

## Inter-Thread Communication

### Message Queue
- Thread-safe queue for messages
- Main thread pushes new messages
- Message processor thread consumes

### Phone Data Queue
- Thread-safe storage for phone status
- Updated by phone status thread
- Read by signal monitor thread

### Problematic Modems Set
- Thread-safe set of modem IDs that cause crashes
- Updated by all threads
- Read by main thread to skip problematic modems

## Benefits

1. **High-Frequency Message Checking**: Main thread can check all 24 modems in ~5-10 seconds
2. **Non-Blocking Operations**: HTTP uploads don't block message scanning
3. **Fault Isolation**: Crashes in one thread don't affect others
4. **Better Resource Utilization**: Parallel processing of different tasks

## Implementation Notes

- Use Zig's std.Thread for thread management
- Use std.Thread.Mutex for synchronization
- Use std.atomic for lock-free counters
- Keep mmcli operations in main thread only (ModemManager is not thread-safe)