# Orange Pi API Reference

## Interactive API Documentation

Visit the interactive Swagger UI documentation at:
- https://sexy.qzz.io/api-docs
- https://sexy.qzz.io/swagger.json (raw OpenAPI spec)

The Swagger UI provides:
- Interactive API testing
- Complete request/response examples
- Auto-generated code snippets
- Schema validation

## Authentication

All Orange Pi API endpoints require an API key in the request headers:

```
X-API-Key: your-api-key-here
```

## Base URL

```
https://sms-dashboard.xiongchenyu6.workers.dev
```

Or with custom domain:
```
https://sexy.qzz.io
```

## Endpoints

### 1. Upload Messages

**Endpoint:** `POST /api/control/messages`

**Request Body:**
```json
{
  "messages": [
    {
      "id": "msg-001",              // Optional, will auto-generate if not provided
      "phone_id": "SIM_001",        // Required: Phone/SIM identifier
      "phone_number": "+8613800138000",  // Required: Phone number
      "content": "[淘宝] 验证码123456，您正在登录，请勿告诉他人。",  // Required: Message content
      "source": "10690000",         // Optional: Sender number/name
      "timestamp": "2024-01-09T10:30:00Z"  // Optional: ISO 8601 format
    }
  ]
}
```

**Response:**
```json
{
  "success": true,
  "processed": 1,
  "message": "Successfully uploaded 1 messages"
}
```

### 2. Update Phone Status

**Endpoint:** `POST /api/control/phones`

**Request Body:**
```json
{
  "phones": [
    {
      "id": "SIM_001",              // Required: Phone/SIM identifier
      "number": "+8613800138000",   // Optional: Phone number
      "country": "CN",              // Optional: Country code
      "flag": "🇨🇳",                // Optional: Country flag emoji
      "carrier": "中国移动",         // Optional: Carrier name
      "status": "online",           // Required: online/offline/error
      "signal": 85,                 // Optional: Signal strength (0-100)
      "iccid": "89860000000000000000",  // Optional: SIM ICCID
      "rssi": -44.0,               // Optional: RSSI in dBm
      "rsrq": -6.0,                // Optional: RSRQ in dB
      "rsrp": -70.0,               // Optional: RSRP in dBm
      "snr": 28.0                  // Optional: SNR in dB
    }
  ]
}
```

**Response:**
```json
{
  "success": true,
  "updated": 1,
  "message": "Successfully updated 1 phones"
}
```

## Example Usage

### Python Example

```python
import requests
import json
from datetime import datetime

API_KEY = "your-api-key-here"
BASE_URL = "https://sms-dashboard.xiongchenyu6.workers.dev"

headers = {
    "X-API-Key": API_KEY,
    "Content-Type": "application/json"
}

# Upload a message
message_data = {
    "messages": [{
        "phone_id": "SIM_001",
        "phone_number": "+8613800138000",
        "content": "[测试] 验证码654321",
        "timestamp": datetime.utcnow().isoformat() + "Z"
    }]
}

response = requests.post(
    f"{BASE_URL}/api/control/messages",
    headers=headers,
    json=message_data
)

print(response.json())

# Update phone status
phone_data = {
    "phones": [{
        "id": "SIM_001",
        "status": "online",
        "signal": 75,
        "rssi": -52.0
    }]
}

response = requests.post(
    f"{BASE_URL}/api/control/phones",
    headers=headers,
    json=phone_data
)

print(response.json())
```

### Shell Script Example

```bash
#!/bin/bash

API_KEY="your-api-key-here"
BASE_URL="https://sms-dashboard.xiongchenyu6.workers.dev"

# Upload message
curl -X POST "$BASE_URL/api/control/messages" \
  -H "X-API-Key: $API_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "messages": [{
      "phone_id": "SIM_001",
      "phone_number": "+8613800138000",
      "content": "[测试] 验证码123456",
      "timestamp": "'$(date -u +%Y-%m-%dT%H:%M:%SZ)'"
    }]
  }'

# Update phone status
curl -X POST "$BASE_URL/api/control/phones" \
  -H "X-API-Key: $API_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "phones": [{
      "id": "SIM_001",
      "status": "online",
      "signal": 85
    }]
  }'
```

## Signal Strength Mapping

When using `mmcli` to get signal strength:

```bash
mmcli -m 0 --signal-get
```

Map the values as follows:
- RSSI: Use directly (e.g., -44 dBm)
- RSRQ: Use directly (e.g., -6 dB)  
- RSRP: Use directly (e.g., -70 dBm)
- SNR: Use directly (e.g., 28 dB)
- Signal percentage: Calculate from RSSI
  - Excellent: > -50 dBm (100%)
  - Good: -50 to -60 dBm (75-99%)
  - Fair: -60 to -70 dBm (50-74%)
  - Poor: < -70 dBm (25-49%)

## Error Handling

Common error responses:

```json
{
  "success": false,
  "error": "Unauthorized"
}
```

```json
{
  "success": false,
  "error": "Messages must be an array"
}
```

## Rate Limits

- Maximum 50 messages per request
- Messages are processed in batches for performance
- Real-time updates are broadcast via WebSocket/SSE to all connected clients

## Notes

1. The API automatically extracts verification codes from messages
2. Timestamps are optional - server will use current time if not provided
3. Phone status updates trigger real-time updates to all connected dashboard users
4. ICCID can be used to map SIM cards to phone numbers