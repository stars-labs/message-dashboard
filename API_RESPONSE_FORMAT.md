# API Response Format Documentation

## Overview

As of v2.0, all API endpoints use a standardized response format implemented via `/server/utils/api-response.js`. This ensures consistency across the entire API surface.

## Response Structure

### Success Response

```json
{
  "success": true,
  "data": { ... },
  "message": "Optional success message"
}
```

### Error Response

```json
{
  "success": false,
  "error": "Error message",
  "details": { ... }  // Optional additional error details
}
```

## Standard Response Functions

### `success(data, message = null)`
Returns a successful response with optional message.

```javascript
import { success } from './utils/api-response.js';

// Simple success
return success({ count: 10 });

// Success with message
return success({ id: "123" }, "Device created successfully");
```

### `error(message, status = 500, details = null)`
Returns an error response with custom status code.

```javascript
import { error } from './utils/api-response.js';

// Simple error
return error("Database connection failed");

// Error with status and details
return error("Invalid input", 400, { field: "iccid", reason: "missing" });
```

### `validationError(errors)`
Returns a 400 validation error with details.

```javascript
import { validationError } from './utils/api-response.js';

return validationError({
  iccid: "ICCID must be 19-20 digits",
  phone_number: "Invalid phone number format"
});
```

### `notFound(resource = 'Resource')`
Returns a 404 not found error.

```javascript
import { notFound } from './utils/api-response.js';

return notFound("Device");  // "Device not found"
return notFound();          // "Resource not found"
```

### `unauthorized(message = 'Unauthorized')`
Returns a 401 unauthorized error.

```javascript
import { unauthorized } from './utils/api-response.js';

return unauthorized("Invalid API key");
return unauthorized();  // "Unauthorized"
```

## API Endpoint Examples

### GET /api/stats
```json
{
  "success": true,
  "data": {
    "modems": {
      "total": 48,
      "connected": 45,
      "disconnected": 3,
      "with_sims": 42
    },
    "sims": {
      "total": 42,
      "active": 40,
      "inactive": 2
    },
    "daemon": {
      "status": "online",
      "health": "healthy",
      "reported_count": 45,
      "last_heartbeat": "2025-08-09T10:30:00Z"
    },
    "online_count": 45,
    "total_count": 48
  }
}
```

### POST /api/control/phones
```json
// Request
{
  "phones": [
    {
      "id": "89860121652000047334",
      "equipment_id": "865827078383361",
      "manufacturer": "QUALCOMM INCORPORATED",
      "model": "QUECTEL Mobile Broadband Module",
      "firmware_revision": "EC20CEHDLGR08A02M1G",
      "status": "online"
    }
  ]
}

// Response
{
  "success": true,
  "data": {
    "processed": 1,
    "updated": {
      "modems": 1,
      "sims": 1,
      "states": 1
    },
    "errors": []
  },
  "message": "Phone data updated successfully"
}
```

### Error Response Examples

#### Validation Error
```json
{
  "success": false,
  "error": "Validation failed",
  "details": {
    "equipment_id": "Equipment ID must be numeric or in MODEM_X format",
    "iccid": "ICCID must be 19-20 digits"
  }
}
```

#### Database Error
```json
{
  "success": false,
  "error": "Database operation failed",
  "details": {
    "operation": "insert",
    "table": "modems",
    "constraint": "PRIMARY KEY constraint failed"
  }
}
```

## Performance Statistics

Some endpoints include performance metrics in the response:

```json
{
  "success": true,
  "data": { ... },
  "performance": {
    "duration_ms": 45,
    "cache_hit": true,
    "statements_cached": 12
  }
}
```

## Migration Notes

- The `device_view` maintains backward compatibility with the old `phones` table structure
- Legacy endpoints continue to work but internally use the new normalized tables
- All new endpoints should use the standardized response format
- Batch operations use transactions for data consistency