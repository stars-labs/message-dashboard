# WebSocket Protocol Documentation

## Overview

Bidirectional WebSocket communication between Orange Pi Zig daemon and Cloudflare Workers for real-time SMS management.

## Connection

- **Endpoint**: `wss://sexy.qzz.io/api/daemon-ws`
- **Authentication**: API key in initial handshake
- **Reconnection**: Automatic with exponential backoff

## Message Format

All messages are JSON with this structure:
```json
{
  "type": "message_type",
  "id": "unique_message_id", 
  "timestamp": "2025-07-15T10:00:00Z",
  "data": { ... }
}
```

## Daemon → Server Messages

### 1. Authentication
```json
{
  "type": "auth",
  "id": "auth-001",
  "timestamp": "2025-07-15T10:00:00Z",
  "data": {
    "api_key": "your-api-key",
    "daemon_version": "1.0.0",
    "device_id": "orange-pi-001"
  }
}
```

### 2. Phone Status Update
```json
{
  "type": "phone_update",
  "id": "phone-update-001", 
  "timestamp": "2025-07-15T10:00:00Z",
  "data": {
    "phones": [
      {
        "iccid": "89860040191833946266",
        "number": "6590950236",
        "status": "online",
        "signal": 85,
        "carrier": "Singtel",
        "operator_name": "Singtel",
        "operator_id": "52501",
        "imei": "357043090123456",
        "access_tech": "lte",
        "rssi": -65,
        "rsrp": -95,
        "rsrq": -10,
        "snr": 15
      }
    ]
  }
}
```

### 3. Message Upload
```json
{
  "type": "message_upload",
  "id": "msg-upload-001",
  "timestamp": "2025-07-15T10:00:00Z", 
  "data": {
    "messages": [
      {
        "id": "msg-001",
        "phone_id": "89860040191833946266",
        "phone_number": "6590950236",
        "content": "Your verification code is: 123456",
        "source": "incoming",
        "timestamp": "2025-07-15T09:55:00Z",
        "sender": "92401051"
      }
    ]
  }
}
```

### 4. Send Message Result
```json
{
  "type": "send_result",
  "id": "send-result-001",
  "timestamp": "2025-07-15T10:00:00Z",
  "data": {
    "request_id": "send-msg-001",
    "success": true,
    "message": "SMS sent successfully",
    "sms_id": "sms-12345"
  }
}
```

### 5. Heartbeat
```json
{
  "type": "heartbeat",
  "id": "heartbeat-001",
  "timestamp": "2025-07-15T10:00:00Z",
  "data": {
    "uptime": 3600,
    "memory_usage": 45.2,
    "active_modems": 3
  }
}
```

## Server → Daemon Messages

### 1. Authentication Response
```json
{
  "type": "auth_response",
  "id": "auth-response-001",
  "timestamp": "2025-07-15T10:00:00Z",
  "data": {
    "success": true,
    "message": "Authenticated successfully",
    "daemon_id": "daemon-12345"
  }
}
```

### 2. Send Message Request
```json
{
  "type": "send_message",
  "id": "send-msg-001",
  "timestamp": "2025-07-15T10:00:00Z",
  "data": {
    "phone_id": "89860040191833946266",
    "recipient": "92401051",
    "content": "Your verification code is: 567890",
    "priority": "high"
  }
}
```

### 3. Get Status Request
```json
{
  "type": "get_status", 
  "id": "status-req-001",
  "timestamp": "2025-07-15T10:00:00Z",
  "data": {}
}
```

### 4. Configuration Update
```json
{
  "type": "config_update",
  "id": "config-001",
  "timestamp": "2025-07-15T10:00:00Z",
  "data": {
    "upload_interval": 30,
    "heartbeat_interval": 60,
    "log_level": "info"
  }
}
```

### 5. Heartbeat Response
```json
{
  "type": "heartbeat_response",
  "id": "heartbeat-response-001", 
  "timestamp": "2025-07-15T10:00:00Z",
  "data": {
    "server_time": "2025-07-15T10:00:00Z",
    "next_heartbeat": 60
  }
}
```

## Error Handling

### Error Response Format
```json
{
  "type": "error",
  "id": "error-001",
  "timestamp": "2025-07-15T10:00:00Z",
  "data": {
    "code": "SEND_FAILED",
    "message": "Failed to send SMS: No signal",
    "request_id": "send-msg-001",
    "retry": true
  }
}
```

### Error Codes
- `AUTH_FAILED` - Authentication failed
- `SEND_FAILED` - SMS sending failed  
- `MODEM_ERROR` - Modem communication error
- `INVALID_REQUEST` - Invalid message format
- `RATE_LIMITED` - Too many requests
- `INTERNAL_ERROR` - Server internal error

## Connection Management

### Heartbeat
- Daemon sends heartbeat every 60 seconds
- Server responds with heartbeat_response
- Connection considered dead after 3 missed heartbeats

### Reconnection
- Automatic reconnection with exponential backoff
- Starting delay: 1 second
- Maximum delay: 300 seconds (5 minutes)
- Re-authenticate on reconnection

### Message Acknowledgment
- All requests should receive a response
- Timeout: 30 seconds for send_message requests
- Retry failed sends up to 3 times