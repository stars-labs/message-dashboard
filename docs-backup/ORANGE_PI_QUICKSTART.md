# Orange Pi Quick Start Guide

## API Configuration

**Base URL:** `https://sms-dashboard-api.xiongchenyu6.workers.dev`  
**API Key:** `af1f81f4398114f93860a83c0643974143971c8e4740e0301c74393124e3d2ae`

## Quick Test

Test your connection first:

```bash
curl -X POST https://sms-dashboard-api.xiongchenyu6.workers.dev/api/control/messages \
  -H "X-API-Key: af1f81f4398114f93860a83c0643974143971c8e4740e0301c74393124e3d2ae" \
  -H "Content-Type: application/json" \
  -d '{"messages": []}'
```

Expected response: `{"success":true,"processed":0,"message":"Successfully uploaded 0 messages"}`

## Upload Messages

### Single Message Example

```bash
#!/bin/bash

API_KEY="af1f81f4398114f93860a83c0643974143971c8e4740e0301c74393124e3d2ae"
API_URL="https://sms-dashboard-api.xiongchenyu6.workers.dev/api/control/messages"

# Upload a message
curl -X POST "$API_URL" \
  -H "X-API-Key: $API_KEY" \
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

### Batch Upload Example

```python
import requests
import json
from datetime import datetime

API_KEY = "af1f81f4398114f93860a83c0643974143971c8e4740e0301c74393124e3d2ae"
API_URL = "https://sms-dashboard-api.xiongchenyu6.workers.dev/api/control/messages"

# Prepare multiple messages
messages = []
for i in range(10):
    messages.append({
        "phone_id": f"SIM_{i+1:03d}",
        "phone_number": f"+861380013800{i}",
        "content": f"Test message {i}: Verification code {100000+i}",
        "source": "+1234567890",
        "timestamp": datetime.utcnow().isoformat() + "Z"
    })

# Upload in batch
response = requests.post(
    API_URL,
    headers={
        "X-API-Key": API_KEY,
        "Content-Type": "application/json"
    },
    json={"messages": messages}
)

print(f"Status: {response.status_code}")
print(f"Response: {response.json()}")
```

## Update Phone Status

```python
import requests

API_KEY = "af1f81f4398114f93860a83c0643974143971c8e4740e0301c74393124e3d2ae"
API_URL = "https://sms-dashboard-api.xiongchenyu6.workers.dev/api/control/phones"

phones = [
    {
        "id": "SIM_001",
        "number": "+8613800138001",
        "country": "中国",
        "flag": "🇨🇳",
        "carrier": "中国移动",
        "status": "online",
        "signal": 85
    },
    {
        "id": "SIM_002",
        "number": "+8613800138002",
        "country": "中国",
        "flag": "🇨🇳",
        "carrier": "中国联通",
        "status": "online",
        "signal": 92
    }
]

response = requests.post(
    API_URL,
    headers={
        "X-API-Key": API_KEY,
        "Content-Type": "application/json"
    },
    json={"phones": phones}
)

print(response.json())
```

## Minimal Python Script

Save as `sms_uploader.py`:

```python
#!/usr/bin/env python3
import requests
import json
import time

# Configuration
API_KEY = "af1f81f4398114f93860a83c0643974143971c8e4740e0301c74393124e3d2ae"
BASE_URL = "https://sms-dashboard-api.xiongchenyu6.workers.dev"

def upload_message(phone_id, phone_number, content, source=None):
    """Upload a single message"""
    response = requests.post(
        f"{BASE_URL}/api/control/messages",
        headers={
            "X-API-Key": API_KEY,
            "Content-Type": "application/json"
        },
        json={
            "messages": [{
                "phone_id": phone_id,
                "phone_number": phone_number,
                "content": content,
                "source": source
            }]
        }
    )
    return response.json()

def update_phone_status(phone_id, number, status="online", signal=50):
    """Update phone status"""
    response = requests.post(
        f"{BASE_URL}/api/control/phones",
        headers={
            "X-API-Key": API_KEY,
            "Content-Type": "application/json"
        },
        json={
            "phones": [{
                "id": phone_id,
                "number": number,
                "country": "中国",
                "flag": "🇨🇳",
                "carrier": "中国移动",
                "status": status,
                "signal": signal
            }]
        }
    )
    return response.json()

# Example usage
if __name__ == "__main__":
    # Update phone status
    print(update_phone_status("SIM_001", "+8613800138001", "online", 85))
    
    # Upload a message
    print(upload_message(
        "SIM_001", 
        "+8613800138001", 
        "Your verification code is 123456",
        "+1234567890"
    ))
```

## Environment Variables

For production, use environment variables:

```bash
# /etc/environment or ~/.bashrc
export SMS_API_KEY="af1f81f4398114f93860a83c0643974143971c8e4740e0301c74393124e3d2ae"
export SMS_API_URL="https://sms-dashboard-api.xiongchenyu6.workers.dev"
```

Then in your script:
```python
import os

API_KEY = os.environ.get('SMS_API_KEY')
API_URL = os.environ.get('SMS_API_URL')
```

## Systemd Service (Optional)

Create `/etc/systemd/system/sms-uploader.service`:

```ini
[Unit]
Description=SMS Dashboard Uploader
After=network.target

[Service]
Type=simple
User=pi
WorkingDirectory=/home/pi
ExecStart=/usr/bin/python3 /home/pi/sms_uploader.py
Restart=always
RestartSec=10
Environment="SMS_API_KEY=af1f81f4398114f93860a83c0643974143971c8e4740e0301c74393124e3d2ae"
Environment="SMS_API_URL=https://sms-dashboard-api.xiongchenyu6.workers.dev"

[Install]
WantedBy=multi-user.target
```

Enable and start:
```bash
sudo systemctl enable sms-uploader
sudo systemctl start sms-uploader
sudo systemctl status sms-uploader
```

## Troubleshooting

1. **Test connectivity**: `curl -I https://sms-dashboard-api.xiongchenyu6.workers.dev/api/health`
2. **Check API key**: Ensure no extra spaces or newlines
3. **View logs**: Check Cloudflare dashboard or `wrangler tail`
4. **JSON format**: Use a JSON validator for your payload

## Support

- API issues: Check the Cloudflare Workers logs
- Integration help: See the full API documentation
- Real-time monitoring: Visit https://sexy.qzz.io (after setup)