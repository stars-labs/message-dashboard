# SMS Dashboard API

## Base URL
- **Production**: `https://sexy.itoken.world`
- **Development**: `http://localhost:8787`

## Authentication

### Bearer Token (Users)
Auth0 JWT for web client requests:
```http
Authorization: Bearer <jwt_token>
```

### API Key (Daemon)
For daemon/service requests:
```http
X-API-Key: <api_key>
```

## Response Format

```json
// Success
{ "success": true, "data": { ... } }

// Error
{ "success": false, "error": "Error message" }
```

## Endpoints

### Health

| Method | Path | Auth | Description |
|--------|------|------|-------------|
| GET | `/api/health` | None | Basic health check |
| GET | `/api/daemon/status` | Bearer | Daemon status + statistics |
| GET | `/api/health/metrics` | Bearer | Signal/error/activity metrics |

### Phones

| Method | Path | Auth | Description |
|--------|------|------|-------------|
| GET | `/api/phones` | Bearer | List all phones (from `device_view`) |
| GET | `/api/phones/:id` | Bearer | Phone details by ICCID |
| PUT | `/api/phones/:id` | Bearer | Update phone number/carrier/status |
| DELETE | `/api/phones/:id` | Bearer | Delete phone |

**GET /api/phones query params**: `status`, `search`

### Messages

| Method | Path | Auth | Description |
|--------|------|------|-------------|
| GET | `/api/messages` | Bearer | List messages with pagination |
| GET | `/api/messages/:id` | Bearer | Get single message |
| POST | `/api/messages/send` | Bearer | Send SMS via daemon |
| DELETE | `/api/messages/:id` | Bearer | Delete message |
| GET | `/api/messages/stats` | Bearer | Message count statistics |

**GET /api/messages query params**: `phone_iccid`, `limit` (default 50), `offset`,
`since` (ingestion timestamp for incremental sync), `include_filtered=1`. Incremental
continuation requests use the response's `sync.server_time` as `until` and its
`pagination.next_cursor` fields as `before_created_at` and `before_id`.

Message pagination is bounded: `pagination.has_more` and `next_offset` come from
fetching one extra row. Incremental pages use a stable `(created_at, id)` keyset
within one fixed ingestion window; `next_offset` is only for ordinary history pages.
The endpoint deliberately does not return exact history totals because counting the
complete message table would amplify every inbox read.

**POST /api/messages/send body**:
```json
{
  "phone_iccid": "89860121652000047334",
  "recipient": "+1234567890",
  "content": "Hello"
}
```

### Statistics

| Method | Path | Auth | Description |
|--------|------|------|-------------|

### Keywords

| Method | Path | Auth | Description |
|--------|------|------|-------------|
| GET | `/api/keywords` | Bearer | List keyword tags |
| POST | `/api/keywords` | Bearer | Create keyword tag |
| PUT | `/api/keywords/:id` | Bearer | Update keyword tag |
| DELETE | `/api/keywords/:id` | Bearer | Delete keyword tag |

### ICCID Mappings

| Method | Path | Auth | Description |
|--------|------|------|-------------|
| GET | `/api/iccid-mappings` | Bearer | List ICCID-to-phone mappings |
| POST | `/api/iccid-mappings` | Bearer | Create/update mapping |
| POST | `/api/iccid-mappings/batch` | Bearer | Bulk import from CSV |
| DELETE | `/api/iccid-mappings/:iccid` | Bearer | Delete mapping |

### User Overrides

| Method | Path | Auth | Description |
|--------|------|------|-------------|
| PUT | `/api/phones/:iccid/override` | Bearer | Set user phone number/carrier override |
| DELETE | `/api/phones/:iccid/override` | Bearer | Remove override |

### Updates (Polling)

### Control API (Daemon only)

| Method | Path | Auth | Description |
|--------|------|------|-------------|
| POST | `/api/control/devices` | API Key | Sync modem/SIM/signal data |
| POST | `/api/control/messages` | API Key | Upload received SMS |
| POST | `/api/control/heartbeat` | API Key | Daemon health heartbeat |
| GET | `/api/control/pending-sms` | API Key | Get outgoing SMS queue |
| POST | `/api/control/sms-result` | API Key | Report SMS send result |

### Auth0

| Method | Path | Auth | Description |
|--------|------|------|-------------|
| GET | `/api/auth/login` | None | Redirect to Auth0 login |
| GET | `/api/auth/callback` | None | Auth0 callback handler |
| GET | `/api/auth/logout` | None | Logout + clear session |
| GET | `/api/auth/me` | Bearer | Get current user info |

## Error Codes

| Code | Description |
|------|-------------|
| 400 | Bad Request — invalid parameters |
| 401 | Unauthorized — missing/invalid auth |
| 403 | Forbidden — insufficient permissions |
| 404 | Not Found |
| 500 | Internal Server Error |

## Notes

- No WebSocket/SSE in production (cost optimization). UI refreshes data via direct HTTP API calls.
- RBAC is enforced and fails closed. Every endpoint requires the `sms` role (or an
  alternative role) — a user without it gets 403, and there is no setting that grants
  access without a role.
- The daemon checks device state every 30s, sends only changed or removed modems,
  and performs a full reconciliation only at startup or after repeated failures.
