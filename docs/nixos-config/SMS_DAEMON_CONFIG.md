# SMS Daemon Configuration Guide

## Timing Configuration

The SMS daemon has three independent timing intervals that control different aspects of its operation:

### 1. Phone Update Interval (`phoneUpdateIntervalSeconds`)
- **Unit**: Seconds
- **Default**: 30 seconds
- **Purpose**: How often to check and update phone/modem status (online/offline, phone number, operator info)
- **Example**: `phoneUpdateIntervalSeconds = 30` means phone status is updated every 30 seconds

### 2. Message Check Interval (`messageCheckIntervalMs`)
- **Unit**: Milliseconds (1000ms = 1 second)
- **Default**: 1000ms (1 Hz, or 1 time per second)
- **Purpose**: How often to check for new SMS messages on all modems
- **Example**: `messageCheckIntervalMs = 1000` means checking for messages once per second
- **Common values**:
  - `100` = 10 Hz (10 checks per second) - High frequency (WARNING: May cause mmcli crashes)
  - `200` = 5 Hz (5 checks per second) - Moderate (Use with caution)
  - `500` = 2 Hz (2 checks per second) - Balanced
  - `1000` = 1 Hz (1 check per second) - Default (Recommended)
  - `2000` = 0.5 Hz (1 check every 2 seconds) - Low frequency

### 3. Signal Check Interval (`signalCheckIntervalSeconds`)
- **Unit**: Seconds
- **Default**: 60 seconds (1 minute)
- **Purpose**: How often to check signal quality (RSSI, RSRQ, RSRP, SNR)
- **Example**: `signalCheckIntervalSeconds = 60` means signal quality is checked every minute

## Example Configurations

### High Performance (for time-critical message reception)
```nix
services.sms-daemon = {
  enable = true;
  phoneUpdateIntervalSeconds = 30;      # Standard phone updates
  messageCheckIntervalMs = 50;          # 20 Hz - very frequent message checks
  signalCheckIntervalSeconds = 120;     # Less frequent signal checks to reduce load
};
```

### Balanced (default)
```nix
services.sms-daemon = {
  enable = true;
  phoneUpdateIntervalSeconds = 30;      # Every 30 seconds
  messageCheckIntervalMs = 100;         # 10 Hz
  signalCheckIntervalSeconds = 60;      # Every minute
};
```

### Power Saving / Low Resource Usage
```nix
services.sms-daemon = {
  enable = true;
  phoneUpdateIntervalSeconds = 60;      # Less frequent phone updates
  messageCheckIntervalMs = 1000;        # 1 Hz - check messages once per second
  signalCheckIntervalSeconds = 300;     # Check signal every 5 minutes
};
```

## Environment Variables

If you're running the daemon manually, you can set these environment variables:
- `SMS_CHECK_INTERVAL` - Phone update interval in seconds
- `SMS_MESSAGE_CHECK_INTERVAL` - Message check interval in milliseconds
- `SMS_SIGNAL_CHECK_INTERVAL` - Signal check interval in seconds

Example:
```bash
export SMS_CHECK_INTERVAL=30
export SMS_MESSAGE_CHECK_INTERVAL=100
export SMS_SIGNAL_CHECK_INTERVAL=60
./sms-daemon
```

## Performance Considerations

- **CPU Usage**: Lower `messageCheckIntervalMs` values increase CPU usage
- **Modem Load**: Very frequent checks may stress USB modems
- **Network Traffic**: More frequent phone/signal updates mean more API calls
- **Message Latency**: Lower `messageCheckIntervalMs` reduces time to detect new messages

## Troubleshooting

If you see high CPU usage:
1. Increase `messageCheckIntervalMs` (e.g., from 100 to 200 or 500)
2. Check daemon logs for errors that might cause repeated retries

If messages are delayed:
1. Decrease `messageCheckIntervalMs` (e.g., from 100 to 50)
2. Ensure modems are properly connected and recognized