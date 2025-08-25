# SMS Dashboard API Documentation

## Base URL
- **Production**: `https://sexy.qzz.io`
- **Development**: `http://localhost:8787`

## Authentication

The API uses two authentication methods:

### 1. Bearer Token (User Authentication)
For web client requests, using Auth0 JWT tokens:
```http
Authorization: Bearer <jwt_token>
```

### 2. API Key (Service Authentication)
For daemon/service requests:
```http
X-API-Key: <api_key>
```

## Response Format

All API responses follow this structure:

### Success Response
```json
{
  "success": true,
  "data": { /* response data */ },
  "meta": { /* optional metadata */ }
}
```

### Error Response
```json
{
  "success": false,
  "error": "Error message",
  "details": { /* optional error details */ }
}
```

## Endpoints

### Health & Status

#### Check API Health
```http
GET /api/health
```

**Response:**
```json
{
  "status": "healthy",
  "timestamp": "2025-08-24T12:00:00.000Z",
  "database": "connected",
  "sim_count": 54
}
```

#### Get Daemon Status
```http
GET /api/daemon/status
```

**Response:**
```json
{
  "success": true,
  "system": {
    "status": "healthy",
    "message": "System operational",
    "timestamp": "2025-08-24T12:00:00.000Z"
  },
  "daemons": [
    {
      "daemon_id": "orange-pi-main",
      "status": "online",
      "last_heartbeat": "2025-08-24T11:59:45.000Z",
      "version": "v3.9.0",
      "modem_count": 54
    }
  ],
  "statistics": {
    "total_modems": 54,
    "connected_modems": 54,
    "total_sims": 54,
    "active_sims": 54
  }
}
```

#### Get System Metrics
```http
GET /api/health/metrics
```

**Response:**
```json
{
  "success": true,
  "metrics": {
    "signal": {
      "avg_signal": 75,
      "min_signal": 45,
      "max_signal": 95
    },
    "errors": {
      "modems_with_errors": 0,
      "total_errors": 0
    },
    "activity": {
      "recently_updated_modems": 54,
      "recently_updated_sims": 54
    }
  }
}
```

### Phone Management

#### List All Phones
```http
GET /api/phones
Authorization: Bearer <token>
```

**Query Parameters:**
- `status` - Filter by status (active, inactive, removed)
- `search` - Search by number or carrier

**Response:**
```json
{
  "success": true,
  "data": [
    {
      "id": "89860121652000047334",
      "iccid": "89860121652000047334",
      "number": "+628123456789",
      "country": "Indonesia",
      "flag": "🇮🇩",
      "carrier": "Telkomsel",
      "status": "active",
      "signal": 85,
      "rssi": -65,
      "operator_name": "TELKOMSEL",
      "imei": "865827078383361",
      "modem_index": 1,
      "usb_port": 1,
      "created_at": "2025-08-01T00:00:00.000Z",
      "updated_at": "2025-08-24T12:00:00.000Z"
    }
  ]
}
```

#### Get Phone Details
```http
GET /api/phones/:id
Authorization: Bearer <token>
```

**Response:**
```json
{
  "success": true,
  "data": {
    "id": "89860121652000047334",
    "iccid": "89860121652000047334",
    "number": "+628123456789",
    "country": "Indonesia",
    "carrier": "Telkomsel",
    "status": "active",
    "signal": 85,
    "modem_details": {
      "manufacturer": "Quectel",
      "model": "EC20",
      "firmware_revision": "EC20CEFAR06A15M4G"
    }
  }
}
```

#### Update Phone
```http
PUT /api/phones/:id
Authorization: Bearer <token>
Content-Type: application/json
```

**Request Body:**
```json
{
  "phone_number": "+628123456789",
  "carrier": "Telkomsel",
  "status": "active"
}
```

#### Delete Phone
```http
DELETE /api/phones/:id
Authorization: Bearer <token>
```

### Message Management

#### List Messages
```http
GET /api/messages
Authorization: Bearer <token>
```

**Query Parameters:**
- `phone_id` - Filter by phone ICCID
- `direction` - Filter by direction (incoming, outgoing)
- `search` - Search message content
- `limit` - Results per page (default: 100)
- `offset` - Pagination offset

**Response:**
```json
{
  "success": true,
  "data": [
    {
      "id": "msg-1756015581738-RQh8nPo9IX",
      "phone_id": "89860121652000047334",
      "content": "Your verification code is 123456",
      "direction": "incoming",
      "sender": "+1234567890",
      "timestamp": "2025-08-24T12:00:00.000Z",
      "status": "received",
      "phone_number": "+628123456789",
      "carrier": "Telkomsel",
      "country": "Indonesia",
      "tags": [
        {
          "keyword": "verification",
          "tag": "OTP",
          "color": "#3B82F6"
        }
      ]
    }
  ],
  "pagination": {
    "limit": 100,
    "offset": 0,
    "total": 484
  }
}
```

#### Get Message
```http
GET /api/messages/:id
Authorization: Bearer <token>
```

#### Send Message
```http
POST /api/messages/send
Authorization: Bearer <token>
Content-Type: application/json
```

**Request Body:**
```json
{
  "phone_id": "89860121652000047334",
  "recipient": "+1234567890",
  "content": "Hello, this is a test message"
}
```

**Response:**
```json
{
  "success": true,
  "data": {
    "id": "msg-1756015581738-abc123",
    "status": "pending"
  }
}
```

#### Delete Message
```http
DELETE /api/messages/:id
Authorization: Bearer <token>
```

#### Get Message Statistics
```http
GET /api/messages/stats
Authorization: Bearer <token>
```

**Query Parameters:**
- `phone_id` - Get stats for specific phone

**Response:**
```json
{
  "success": true,
  "data": {
    "total": 484,
    "incoming": 484,
    "outgoing": 0,
    "pending": 0,
    "sent": 0,
    "failed": 0
  }
}
```

### Control API (Daemon)

#### Update Phone Status
```http
POST /api/control/phones
X-API-Key: <api_key>
Content-Type: application/json
```

**Request Body:**
```json
{
  "phones": [
    {
      "iccid": "89860121652000047334",
      "number": "+628123456789",
      "status": "active",
      "signal": 85,
      "carrier": "Telkomsel",
      "operator_name": "TELKOMSEL"
    }
  ]
}
```

#### Upload Messages
```http
POST /api/control/messages
X-API-Key: <api_key>
Content-Type: application/json
```

**Request Body:**
```json
{
  "messages": [
    {
      "phone_id": "89860121652000047334",
      "content": "Message content",
      "sender": "+1234567890",
      "timestamp": "2025-08-24T12:00:00.000Z",
      "direction": "incoming"
    }
  ]
}
```

#### Daemon Heartbeat
```http
POST /api/control/heartbeat
X-API-Key: <api_key>
Content-Type: application/json
```

**Request Body:**
```json
{
  "daemon_id": "orange-pi-main",
  "version": "v3.9.0",
  "modem_count": 54,
  "status": "online",
  "metadata": {
    "cpu_usage": 20,
    "memory_usage": 50,
    "uptime": 86400
  }
}
```

#### Get Pending SMS
```http
GET /api/control/pending-sms
X-API-Key: <api_key>
```

**Response:**
```json
{
  "success": true,
  "pending_messages": [
    {
      "id": "msg-123",
      "recipient": "+1234567890",
      "content": "Test message",
      "phone_iccid": "89860121652000047334"
    }
  ]
}
```

#### Update SMS Result
```http
POST /api/control/sms-result
X-API-Key: <api_key>
Content-Type: application/json
```

**Request Body:**
```json
{
  "message_id": "msg-123",
  "status": "sent",
  "error": null,
  "sent_at": "2025-08-24T12:00:00.000Z"
}
```

### Statistics

#### Get Dashboard Statistics
```http
GET /api/stats
```

**Response:**
```json
{
  "success": true,
  "total_messages": 484,
  "today_messages": 24,
  "total_sent": 0,
  "total_received": 484,
  "online_devices": 54,
  "total_devices": 55,
  "verification_rate": 0.3037,
  "daemon_status": {
    "online": true,
    "last_heartbeat": 1756017478000,
    "version": "v3.9.0",
    "device_id": "orange-pi-main",
    "modem_count": 55
  }
}
```

### AI Features

#### Extract Verification Code
```http
POST /api/ai/extract-code
Authorization: Bearer <token>
Content-Type: application/json
```

**Request Body:**
```json
{
  "content": "Your verification code is 123456. Do not share."
}
```

**Response:**
```json
{
  "success": true,
  "data": {
    "code": "123456",
    "type": "numeric",
    "confidence": 0.95
  }
}
```

#### Classify Message
```http
POST /api/ai/classify-message
Authorization: Bearer <token>
Content-Type: application/json
```

**Request Body:**
```json
{
  "content": "Your package has been delivered"
}
```

**Response:**
```json
{
  "success": true,
  "data": {
    "category": "delivery",
    "confidence": 0.88,
    "tags": ["shipping", "notification"]
  }
}
```

#### Semantic Search
```http
GET /api/ai/search?q=verification+code
Authorization: Bearer <token>
```

**Response:**
```json
{
  "success": true,
  "data": [
    {
      "id": "msg-123",
      "content": "Your verification code is 123456",
      "similarity": 0.95,
      "timestamp": "2025-08-24T12:00:00.000Z"
    }
  ]
}
```

### Keywords Management

#### List Keywords
```http
GET /api/keywords
Authorization: Bearer <token>
```

**Response:**
```json
{
  "success": true,
  "data": [
    {
      "id": 1,
      "keyword": "verification",
      "tag": "OTP",
      "color": "#3B82F6",
      "priority": 10,
      "is_active": true,
      "case_sensitive": false,
      "whole_word": true
    }
  ]
}
```

#### Create Keyword
```http
POST /api/keywords
Authorization: Bearer <token>
Content-Type: application/json
```

**Request Body:**
```json
{
  "keyword": "verification",
  "tag": "OTP",
  "color": "#3B82F6",
  "priority": 10,
  "case_sensitive": false,
  "whole_word": true
}
```

#### Update Keyword
```http
PUT /api/keywords/:id
Authorization: Bearer <token>
Content-Type: application/json
```

#### Delete Keyword
```http
DELETE /api/keywords/:id
Authorization: Bearer <token>
```

### WebSocket/SSE Events

#### Connect to Updates Stream
```http
GET /api/updates
Authorization: Bearer <token>
Accept: text/event-stream
```

**Events:**
```
event: phone:update
data: {"id":"89860121652000047334","status":"active","signal":85}

event: message:new
data: {"id":"msg-123","phone_id":"89860121652000047334","content":"New message"}

event: daemon:heartbeat
data: {"daemon_id":"orange-pi-main","status":"online","timestamp":"2025-08-24T12:00:00.000Z"}
```

## Rate Limiting

- **Authenticated requests**: 1000 requests per minute
- **Public endpoints**: 100 requests per minute
- **Control API**: No rate limiting (trusted source)

## Error Codes

| Code | Description |
|------|-------------|
| 400 | Bad Request - Invalid parameters |
| 401 | Unauthorized - Missing or invalid authentication |
| 403 | Forbidden - Insufficient permissions |
| 404 | Not Found - Resource not found |
| 429 | Too Many Requests - Rate limit exceeded |
| 500 | Internal Server Error |
| 503 | Service Unavailable |

## Permissions

Required permissions for endpoints:

| Endpoint | Permission |
|----------|------------|
| GET /api/phones | phones.read |
| PUT /api/phones/:id | phones.write |
| DELETE /api/phones/:id | phones.write |
| GET /api/messages | messages.read |
| POST /api/messages/send | messages.send |
| DELETE /api/messages/:id | messages.write |
| GET /api/keywords | keywords.read |
| POST /api/keywords | keywords.write |
| PUT /api/keywords/:id | keywords.write |
| DELETE /api/keywords/:id | keywords.write |

## CORS

CORS is enabled for all origins in development. In production, configure allowed origins in `wrangler.toml`.

## Pagination

Use `limit` and `offset` parameters for pagination:
```http
GET /api/messages?limit=50&offset=100
```

## Filtering

Most list endpoints support filtering:
```http
GET /api/messages?phone_id=89860121652000047334&direction=incoming
```

## Sorting

Default sorting is by most recent first. Some endpoints support custom sorting:
```http
GET /api/messages?sort=timestamp&order=asc
```

## Webhooks

Configure webhooks for real-time notifications:

```json
{
  "url": "https://your-webhook-url.com",
  "events": ["message:new", "phone:status"],
  "secret": "webhook_secret"
}
```

## SDK Examples

### JavaScript/TypeScript
```typescript
import { SmsClient } from '@sms-dashboard/sdk';

const client = new SmsClient({
  baseUrl: 'https://sexy.qzz.io',
  token: 'your_bearer_token'
});

// Get phones
const phones = await client.phones.list();

// Send message
const result = await client.messages.send({
  phone_id: '89860121652000047334',
  recipient: '+1234567890',
  content: 'Hello!'
});
```

### Python
```python
from sms_dashboard import Client

client = Client(
    base_url='https://sexy.qzz.io',
    token='your_bearer_token'
)

# Get phones
phones = client.phones.list()

# Send message
result = client.messages.send(
    phone_id='89860121652000047334',
    recipient='+1234567890',
    content='Hello!'
)
```

### cURL
```bash
# Get phones
curl -H "Authorization: Bearer <token>" \
  https://sexy.qzz.io/api/phones

# Send message
curl -X POST \
  -H "Authorization: Bearer <token>" \
  -H "Content-Type: application/json" \
  -d '{"phone_id":"89860121652000047334","recipient":"+1234567890","content":"Hello!"}' \
  https://sexy.qzz.io/api/messages/send
```

## Support

For API support, please contact:
- Email: api-support@example.com
- Documentation: https://docs.example.com
- Status Page: https://status.example.com