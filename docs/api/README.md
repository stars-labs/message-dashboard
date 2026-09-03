# API Documentation (v2.0.0)

## Overview

The SMS Dashboard API provides endpoints for device management, message handling, and system monitoring. The API uses dual authentication: Auth0 JWT tokens for web users and API keys for the Orange Pi daemon. All endpoints return standardized JSON responses and support the normalized v2.0 database schema.

## Base URL

```
Production: https://sexy.itoken.world
Development: http://localhost:8787
```

## Authentication

### 1. Web User Authentication (Auth0 JWT)

For web dashboard users:

```http
GET /api/phones
Authorization: Bearer eyJhbGciOiJSUzI1NiIsInR5cCI6IkpXVCJ9...
```

**JWT Requirements**:
- **Issuer**: `https://your-tenant.auth0.com/`
- **Audience**: Your API identifier
- **Algorithm**: RS256

### 2. Daemon Authentication (API Key)

For Orange Pi daemon uploads:

```http
POST /api/control/devices
X-API-Key: your-api-key-from-wrangler-secrets
Content-Type: application/json
```

## RBAC Permissions

Web users require appropriate permissions:

- `phones.read` - View device information
- `messages.read` - View SMS messages  
- `messages.send` - Send SMS messages
- `keywords.read` - View keyword configurations
- `keywords.write` - Modify keyword settings

## Response Format

All API responses follow this standardized format:

```json
{
  "success": true,
  "data": { ... },
  "timestamp": "2025-01-15T10:30:00Z",
  "request_id": "req_abc123"
}
```

Error responses:

```json
{
  "success": false,
  "error": {
    "code": "VALIDATION_ERROR",
    "message": "Invalid phone_id format",
    "details": { ... }
  },
  "timestamp": "2025-01-15T10:30:00Z",
  "request_id": "req_abc123"
}
```

## API Endpoints

### Device Management

#### GET /api/phones

Retrieve all connected phones/modems with current status.

**Authentication**: JWT Token (requires `phones.read`)

**Response**:
```json
{
  "success": true,
  "data": {
    "phones": [
      {
        "id": "89860121652000047334",
        "phone_number": "+8613800138001",
        "iccid": "89860121652000047334",
        "equipment_id": "865827078383361",
        "manufacturer": "Quectel",
        "model": "EC20",
        "firmware": "EC20CEFAR06A01M1G",
        "hardware_rev": "EC20 R2.0",
        "signal_percent": 85,
        "rssi": -65.0,
        "rsrq": -12.5,
        "rsrp": -95.0,
        "snr": 18.2,
        "operator": "China Mobile",
        "connection_status": "registered",
        "bearer_technology": "LTE",
        "band_info": "Band 3 (1800 MHz)",
        "country_code": "CN",
        "carrier": "China Mobile",
        "status": "active",
        "sim_index": 1,
        "updated_at": "2025-01-15T10:28:45Z",
        "created_at": "2025-01-10T09:15:22Z"
      }
    ],
    "total": 54,
    "online": 52,
    "countries": ["CN", "HK", "SG"],
    "operators": ["China Mobile", "China Unicom", "Singtel", "CSL"]
  }
}
```

#### GET /api/phones/:id

Get detailed information for a specific phone.

**Parameters**:
- `id` (string): Phone ICCID

**Authentication**: JWT Token (requires `phones.read`)

**Response**:
```json
{
  "success": true,
  "data": {
    "phone": {
      "id": "89860121652000047334",
      // ... all phone fields
      "recent_messages": [
        {
          "id": "msg_001",
          "content": "Your verification code is 123456",
          "sender": "+1234567890",
          "created_at": "2025-01-15T10:25:00Z"
        }
      ],
      "message_count_24h": 5,
      "last_message_at": "2025-01-15T10:25:00Z"
    }
  }
}
```

#### POST /api/control/devices

**Daemon endpoint** for normalized modem synchronization.

**Authentication**: API key in the `X-API-Key` header.

The v8 daemon sends `modem_reports` plus `sync_mode`, `session_id`, and
`timestamp`. Each report is keyed by modem `equipment_id` (IMEI); detected SIM
identity belongs in `detected_iccid`. For the exact payload contract, use
`orange-pi-daemon/src/api_client.rs` and `server/handlers/control.js` as the
sources of truth.

The old `/api/control/phones` endpoint was removed because it depended on the
pre-migration-033 schema.

### Message Management

#### GET /api/messages

Retrieve SMS messages with filtering and pagination.

**Authentication**: JWT Token (requires `messages.read`)

**Query Parameters**:
- `limit` (number, default: 50): Number of messages to return
- `offset` (number, default: 0): Pagination offset
- `phone_iccid` (string, optional): Filter by specific phone ICCID
- `since` (ISO datetime, optional): Messages after this timestamp
- `include_filtered` (`1`, optional): Include messages hidden by filter rules
- `until`, `before_created_at`, `before_id`: Opaque incremental continuation values
  copied from `sync.server_time` and `pagination.next_cursor`

**Response**:
```json
{
  "success": true,
  "data": [
    {
        "id": "01JGRM7XFQZ8Z8Z8Z8Z8Z8Z8Z8",
        "phone_iccid": "89860121652000047334",
        "phone_number": "+8613800138001",
        "sender": "+1234567890",
        "content": "Your Amazon verification code is 789012. Do not share this code.",
        "extracted_code": "789012",
        "metadata": {
          "keywords": ["verification", "Amazon"],
          "confidence": 0.95,
          "source_type": "ecommerce"
        },
        "created_at": "2025-01-15T10:25:00Z",
        "updated_at": "2025-01-15T10:25:00Z"
    }
  ],
  "pagination": {
    "limit": 50,
    "offset": 0,
    "has_more": true,
    "next_offset": 50
  }
}
```

Exact inbox and filtered totals are intentionally omitted; the endpoint reads one
extra row to determine `has_more` without scanning complete message history.
Incremental consumers must follow `next_cursor` until `has_more` is false before
advancing their stored ingestion timestamp to `sync.server_time`.

#### POST /api/control/messages

**Daemon endpoint** for bulk message uploads.

**Authentication**: API Key (X-API-Key header)

**Request Body**:
```json
{
  "messages": [
    {
      "id": "01JGRM7XFQZ8Z8Z8Z8Z8Z8Z8Z8",
      "phone_id": "89860121652000047334",
      "phone_number": "+8613800138001",
      "sender": "+1234567890",
      "content": "Your verification code is 456789",
      "timestamp": "2025-01-15T10:25:00Z"
    }
  ]
}
```

**Response**:
```json
{
  "success": true,
  "data": {
    "processed": 1,
    "new_messages": 1,
    "duplicate_messages": 0,
    "extracted_codes": 1,
    "keyword_matches": 2
  }
}
```

#### POST /api/messages/send

Send SMS messages through selected modems.

**Authentication**: JWT Token (requires `messages.send`)

**Request Body**:
```json
{
  "messages": [
    {
      "phone_iccid": "89860121652000047334",
      "recipient": "+1234567890",
      "content": "Test message from SMS Dashboard"
    }
  ]
}
```

**Response**:
```json
{
  "success": true,
  "data": {
    "queued": 1,
    "pending_messages": [
      {
        "id": "pending_001",
        "phone_iccid": "89860121652000047334",
        "recipient": "+1234567890",
        "content": "Test message from SMS Dashboard",
        "status": "queued",
        "created_at": "2025-01-15T10:30:00Z"
      }
    ]
  }
}
```

### System Monitoring

#### GET /api/health

System health check endpoint.

**Authentication**: None required

**Response**:
```json
{
  "success": true,
  "data": {
    "status": "healthy",
    "timestamp": "2025-01-15T10:30:00Z",
    "version": "v2.0.0",
    "database": {
      "status": "connected",
      "response_time_ms": 12
    },
    "daemon": {
      "status": "healthy",
      "last_heartbeat": "2025-01-15T10:29:45Z",
      "version": "v3.6.0",
      "modems_managed": 54
    }
  }
}
```

#### GET /api/stats

System statistics and metrics.

**Authentication**: JWT Token (requires `phones.read`)

**Response**:
```json
{
  "success": true,
  "data": {
    "phones": {
      "total": 54,
      "online": 52,
      "offline": 2,
      "by_country": {
        "CN": 30,
        "HK": 14,
        "SG": 10
      },
      "by_operator": {
        "China Mobile": 18,
        "China Unicom": 12,
        "Singtel": 10,
        "CSL": 14
      }
    },
    "messages": {
      "total": 15678,
      "today": 234,
      "last_hour": 12,
      "with_codes": 156,
      "average_per_day": 187
    },
    "performance": {
      "api_response_time_ms": 45,
      "daemon_cycle_time_ms": 52,
      "database_query_time_ms": 8
    },
    "updated_at": "2025-01-15T10:30:00Z"
  }
}
```

### Keyword Management

#### GET /api/keywords

Retrieve keyword configurations and tags.

**Authentication**: JWT Token (requires `keywords.read`)

**Response**:
```json
{
  "success": true,
  "data": {
    "keywords": [
      {
        "id": "kw_001",
        "keyword": "verification code",
        "tag": "verification",
        "color": "#3b82f6",
        "case_sensitive": false,
        "whole_word": true,
        "priority": 1,
        "usage_count": 1234,
        "created_at": "2025-01-10T09:00:00Z"
      }
    ],
    "tags": [
      {
        "tag": "verification",
        "color": "#3b82f6",
        "keyword_count": 5,
        "message_count": 1234
      }
    ]
  }
}
```

#### POST /api/keywords

Create new keyword configuration.

**Authentication**: JWT Token (requires `keywords.write`)

**Request Body**:
```json
{
  "keyword": "amazon",
  "tag": "ecommerce", 
  "color": "#f59e0b",
  "case_sensitive": false,
  "whole_word": false,
  "priority": 2
}
```

#### PUT /api/keywords/:id

Update existing keyword configuration.

#### DELETE /api/keywords/:id

Remove keyword configuration.

## Error Codes

| Code | HTTP Status | Description |
|------|-------------|-------------|
| `UNAUTHORIZED` | 401 | Missing or invalid authentication |
| `FORBIDDEN` | 403 | Insufficient permissions |
| `NOT_FOUND` | 404 | Resource not found |
| `VALIDATION_ERROR` | 400 | Invalid request data |
| `DUPLICATE_ENTRY` | 409 | Resource already exists |
| `RATE_LIMIT_EXCEEDED` | 429 | Too many requests |
| `INTERNAL_ERROR` | 500 | Server-side error |
| `DATABASE_ERROR` | 503 | Database unavailable |

## Rate Limiting

- **Web Users**: 100 requests/minute per user
- **Daemon**: 1000 requests/minute per API key
- **Health Check**: Unlimited

## Batch Operations

For efficiency, the API supports batch operations:

### Batch Phone Updates
- Maximum: 100 phones per request
- Timeout: 30 seconds
- Uses D1 batch transactions for consistency

### Batch Message Uploads
- Maximum: 50 messages per request
- Automatic deduplication via Bloom filter
- Keyword processing included

## Database Schema Integration

The API automatically handles the v2.0 normalized schema:

### Phone Queries
```sql
-- API automatically joins tables for phone data
SELECT 
  s.iccid as id,
  s.phone_number,
  m.equipment_id,
  m.manufacturer,
  ms.signal_percent
FROM sims s
LEFT JOIN modems m ON s.current_modem_id = m.equipment_id  
LEFT JOIN modem_state ms ON m.equipment_id = ms.modem_id
```

### Message Processing
```sql
-- Message insertion with keyword processing
INSERT INTO messages (id, phone_id, content, extracted_code)
VALUES (?, ?, ?, ?);

-- Automatic keyword tag creation
INSERT INTO message_tags (message_id, tag)
SELECT ?, tag FROM keyword_tags WHERE keyword = ?;
```

## Development & Testing

### Local Development

```bash
cd sms-dashboard
npm run dev:api  # Start Wrangler dev server
```

### API Testing

```bash
# Health check
curl https://sexy.itoken.world/api/health

# Get phones with auth token
curl -H "Authorization: Bearer $JWT_TOKEN" \
     https://sexy.itoken.world/api/phones

# Daemon device synchronization
curl -X POST \
     -H "X-API-Key: $API_KEY" \
     -H "Content-Type: application/json" \
     -d '{"modem_reports": [...], "sync_mode": "incremental"}' \
     https://sexy.itoken.world/api/control/devices
```

### API Client Libraries

#### JavaScript/Node.js
```javascript
const API_BASE = 'https://sexy.itoken.world';

async function getPhones(token) {
  const response = await fetch(`${API_BASE}/api/phones`, {
    headers: {
      'Authorization': `Bearer ${token}`,
      'Content-Type': 'application/json'
    }
  });
  return response.json();
}
```

#### Python
```python
import requests

API_BASE = 'https://sexy.itoken.world'

def get_phones(token):
    headers = {
        'Authorization': f'Bearer {token}',
        'Content-Type': 'application/json'
    }
    response = requests.get(f'{API_BASE}/api/phones', headers=headers)
    return response.json()
```

#### Rust Daemon Client

The maintained client is `orange-pi-daemon/src/api_client.rs`. It sends
normalized modem reports to `/api/control/devices`; do not create clients for
the removed `/api/control/phones` endpoint.

## Migration from v1 API

### Breaking Changes
- Phone ID field changed from `id` to `iccid`
- New equipment_id field for hardware tracking
- Signal data now in separate fields (rssi, rsrq, rsrp, snr)
- Hardware info fields added (manufacturer, model, firmware)

### Backward Compatibility
The `device_view` provides v1 compatibility:
- Same field names as v1
- Automatic joins to normalized tables
- Existing client code works unchanged

### Migration Steps
1. Update client code to use new field names
2. Handle new hardware identification fields
3. Update to new authentication flow if needed
4. Test against /api/health endpoint
5. Monitor response times and error rates

This API provides a complete interface for SMS Dashboard operations while maintaining high performance through the normalized database schema and efficient caching strategies.
