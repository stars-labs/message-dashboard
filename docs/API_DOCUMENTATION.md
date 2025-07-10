# SMS Dashboard API Documentation

## Overview

The SMS Dashboard provides API endpoints for Orange Pi devices to upload messages and update phone statuses. All control API endpoints require authentication using an API key.

## Authentication

All requests to control endpoints must include the API key in the header:

```
X-API-Key: af1f81f4398114f93860a83c0643974143971c8e4740e0301c74393124e3d2ae
```

## Base URL

```
https://sms-dashboard-api.xiongchenyu6.workers.dev
```

## API Endpoints

### 1. Upload Messages

Upload received SMS messages from Orange Pi to the dashboard.

**Endpoint:** `POST /api/control/messages`

**Headers:**
```
X-API-Key: your-api-key
Content-Type: application/json
```

**Request Body:**
```json
{
  "messages": [
    {
      "id": "unique-message-id",         // Optional, will be generated if not provided
      "phone_id": "SIM_001",             // Required: ID of the SIM card
      "phone_number": "+8613800138001",  // Required: Phone number that received the message
      "content": "Your verification code is 123456", // Required: Message content
      "source": "+1234567890",           // Optional: Sender's phone number
      "timestamp": "2024-01-07T12:34:56Z" // Optional: ISO 8601 format, defaults to current time
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

**Example with cURL:**
```bash
curl -X POST https://sms-dashboard-api.xiongchenyu6.workers.dev/api/control/messages \
  -H "X-API-Key: af1f81f4398114f93860a83c0643974143971c8e4740e0301c74393124e3d2ae" \
  -H "Content-Type: application/json" \
  -d '{
    "messages": [
      {
        "phone_id": "SIM_001",
        "phone_number": "+8613800138001",
        "content": "Your verification code is 123456",
        "source": "+1234567890"
      }
    ]
  }'
```

**Example with Python:**
```python
import requests
import json

API_KEY = "af1f81f4398114f93860a83c0643974143971c8e4740e0301c74393124e3d2ae"
API_URL = "https://sms-dashboard-api.xiongchenyu6.workers.dev/api/control/messages"

messages = [
    {
        "phone_id": "SIM_001",
        "phone_number": "+8613800138001",
        "content": "Your verification code is 123456",
        "source": "+1234567890"
    }
]

response = requests.post(
    API_URL,
    headers={
        "X-API-Key": API_KEY,
        "Content-Type": "application/json"
    },
    data=json.dumps({"messages": messages})
)

print(response.json())
```

### 2. Update Phone Status

Update the status and signal strength of phones/SIM cards.

**Endpoint:** `POST /api/control/phones`

**Headers:**
```
X-API-Key: your-api-key
Content-Type: application/json
```

**Request Body:**
```json
{
  "phones": [
    {
      "id": "SIM_001",              // Required: Unique SIM ID
      "number": "+8613800138001",   // Required: Phone number
      "country": "中国",             // Required: Country name
      "flag": "🇨🇳",                // Required: Country flag emoji
      "carrier": "中国移动",         // Required: Carrier name
      "status": "online",           // Required: "online" or "offline"
      "signal": 85                  // Required: Signal strength (0-100)
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

**Example with cURL:**
```bash
curl -X POST https://sms-dashboard-api.xiongchenyu6.workers.dev/api/control/phones \
  -H "X-API-Key: af1f81f4398114f93860a83c0643974143971c8e4740e0301c74393124e3d2ae" \
  -H "Content-Type: application/json" \
  -d '{
    "phones": [
      {
        "id": "SIM_001",
        "number": "+8613800138001",
        "country": "中国",
        "flag": "🇨🇳",
        "carrier": "中国移动",
        "status": "online",
        "signal": 85
      }
    ]
  }'
```

## Orange Pi Integration Example

Here's a complete Python script for Orange Pi integration:

```python
#!/usr/bin/env python3
"""
SMS Dashboard API Client for Orange Pi
Monitors SMS messages and uploads them to the dashboard
"""

import requests
import json
import time
import logging
from datetime import datetime
from typing import List, Dict

# Configuration
API_KEY = "af1f81f4398114f93860a83c0643974143971c8e4740e0301c74393124e3d2ae"
BASE_URL = "https://sms-dashboard-api.xiongchenyu6.workers.dev"
UPLOAD_INTERVAL = 30  # seconds
BATCH_SIZE = 50  # messages per upload

# Logging setup
logging.basicConfig(
    level=logging.INFO,
    format='%(asctime)s - %(name)s - %(levelname)s - %(message)s'
)
logger = logging.getLogger(__name__)

class SMSDashboardClient:
    def __init__(self, api_key: str, base_url: str):
        self.api_key = api_key
        self.base_url = base_url
        self.session = requests.Session()
        self.session.headers.update({
            "X-API-Key": api_key,
            "Content-Type": "application/json"
        })
        
    def upload_messages(self, messages: List[Dict]) -> bool:
        """Upload messages to the dashboard"""
        try:
            response = self.session.post(
                f"{self.base_url}/api/control/messages",
                json={"messages": messages}
            )
            response.raise_for_status()
            result = response.json()
            logger.info(f"Uploaded {result['processed']} messages")
            return True
        except Exception as e:
            logger.error(f"Failed to upload messages: {e}")
            return False
    
    def update_phone_status(self, phones: List[Dict]) -> bool:
        """Update phone status"""
        try:
            response = self.session.post(
                f"{self.base_url}/api/control/phones",
                json={"phones": phones}
            )
            response.raise_for_status()
            result = response.json()
            logger.info(f"Updated {result['updated']} phones")
            return True
        except Exception as e:
            logger.error(f"Failed to update phones: {e}")
            return False

def get_sms_messages():
    """
    Read SMS messages from your modem
    This is a placeholder - implement based on your modem's AT commands
    """
    # Example implementation for AT commands:
    # import serial
    # ser = serial.Serial('/dev/ttyUSB0', 115200)
    # ser.write(b'AT+CMGL="ALL"\r')
    # response = ser.read(1000)
    # Parse response and return messages
    
    return [
        {
            "phone_id": "SIM_001",
            "phone_number": "+8613800138001",
            "content": "Your verification code is 123456",
            "source": "+1234567890",
            "timestamp": datetime.utcnow().isoformat() + "Z"
        }
    ]

def get_modem_status():
    """
    Get modem status and signal strength
    This is a placeholder - implement based on your modem's AT commands
    """
    # Example: AT+CSQ for signal quality
    return [
        {
            "id": "SIM_001",
            "number": "+8613800138001",
            "country": "中国",
            "flag": "🇨🇳",
            "carrier": "中国移动",
            "status": "online",
            "signal": 85
        }
    ]

def main():
    """Main loop"""
    client = SMSDashboardClient(API_KEY, BASE_URL)
    message_buffer = []
    
    # Initial phone status update
    phones = get_modem_status()
    client.update_phone_status(phones)
    
    logger.info("SMS Dashboard client started")
    
    while True:
        try:
            # Get new messages
            new_messages = get_sms_messages()
            message_buffer.extend(new_messages)
            
            # Upload messages in batches
            if len(message_buffer) >= BATCH_SIZE:
                batch = message_buffer[:BATCH_SIZE]
                if client.upload_messages(batch):
                    message_buffer = message_buffer[BATCH_SIZE:]
            
            # Periodic upload of remaining messages
            elif message_buffer and time.time() % UPLOAD_INTERVAL == 0:
                if client.upload_messages(message_buffer):
                    message_buffer = []
            
            # Update phone status every minute
            if time.time() % 60 == 0:
                phones = get_modem_status()
                client.update_phone_status(phones)
            
            time.sleep(1)
            
        except KeyboardInterrupt:
            logger.info("Shutting down...")
            # Upload remaining messages
            if message_buffer:
                client.upload_messages(message_buffer)
            break
        except Exception as e:
            logger.error(f"Error in main loop: {e}")
            time.sleep(5)

if __name__ == "__main__":
    main()
```

## Error Handling

### Common Error Responses

**401 Unauthorized:**
```json
{
  "error": "Unauthorized"
}
```
**Solution:** Check your API key is correct and included in the X-API-Key header.

**400 Bad Request:**
```json
{
  "success": false,
  "error": "Messages must be an array"
}
```
**Solution:** Ensure your request body is properly formatted JSON.

**500 Internal Server Error:**
```json
{
  "success": false,
  "error": "Failed to upload messages"
}
```
**Solution:** Check server logs, may be a database issue.

## Best Practices

1. **Batch Messages**: Upload messages in batches of 50-100 for better performance
2. **Retry Logic**: Implement exponential backoff for failed requests
3. **Local Buffer**: Store messages locally if API is unavailable
4. **Status Updates**: Update phone status every 1-5 minutes
5. **Error Logging**: Log all errors for debugging
6. **HTTPS Only**: Always use HTTPS for API calls

## Rate Limits

- No hard rate limits currently
- Recommended: Max 1 request per second
- Batch operations when possible

## Security

- Keep your API key secure
- Don't commit API keys to version control
- Use environment variables for configuration
- Rotate API keys periodically

## Testing

Test your integration with empty data first:

```bash
# Test message upload
curl -X POST https://sms-dashboard-api.xiongchenyu6.workers.dev/api/control/messages \
  -H "X-API-Key: af1f81f4398114f93860a83c0643974143971c8e4740e0301c74393124e3d2ae" \
  -H "Content-Type: application/json" \
  -d '{"messages": []}'

# Test phone update
curl -X POST https://sms-dashboard-api.xiongchenyu6.workers.dev/api/control/phones \
  -H "X-API-Key: af1f81f4398114f93860a83c0643974143971c8e4740e0301c74393124e3d2ae" \
  -H "Content-Type: application/json" \
  -d '{"phones": []}'
```

Both should return success with 0 processed items.