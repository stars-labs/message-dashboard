# Fix: SMS Result Endpoint 500 Error

## Problem

The SMS sending functionality was working, but when the Rust daemon tried to report SMS results back to the API via `/api/control/sms-result`, it received a 500 Internal Server Error with the message:

```
Failed to report SMS result: 500 Internal Server Error - {"success":false,"error":"Failed to update SMS result"}
```

## Root Cause

The `messages` table in the production database was missing two columns that the `updateSMSResult` handler (in `/home/freeman.xiong/Documents/github/hecoinfo/message-dashboard/sms-dashboard/server/handlers/control.js`, lines 987-991) was trying to update:

1. `error_message` - Used to store error details when SMS sending fails
2. `sms_id` - Used to store the ModemManager SMS ID for tracking

### Code Reference

The handler was trying to execute this SQL:

```javascript
const stmt = env.DB.prepare(`
  UPDATE messages
  SET status = ?, error_message = ?, sms_id = ?, updated_at = CURRENT_TIMESTAMP
  WHERE id = ?
`);
```

But the columns `error_message` and `sms_id` didn't exist in the database, causing the query to fail.

## Solution

Created and executed migration file `/home/freeman.xiong/Documents/github/hecoinfo/message-dashboard/sms-dashboard/migrations/011_add_sms_result_columns.sql`:

```sql
-- Add missing columns for SMS result tracking
-- These columns are used by the /api/control/sms-result endpoint

-- Add error_message column to track SMS send failures
ALTER TABLE messages ADD COLUMN error_message TEXT;

-- Add sms_id column to track ModemManager SMS IDs
ALTER TABLE messages ADD COLUMN sms_id TEXT;
```

## Verification

After running the migration:

```bash
npx wrangler d1 execute sms-dashboard --remote --file=migrations/011_add_sms_result_columns.sql
```

The `messages` table schema now includes:

- Column 11: `error_message` (TEXT, nullable)
- Column 12: `sms_id` (TEXT, nullable)

## Files Changed

1. **Created**: `/home/freeman.xiong/Documents/github/hecoinfo/message-dashboard/sms-dashboard/migrations/011_add_sms_result_columns.sql`
2. **Created**: `/home/freeman.xiong/Documents/github/hecoinfo/message-dashboard/sms-dashboard/scripts/verify-deployment.sh` (test script)

## Testing

The endpoint should now work correctly. When the Rust daemon reports SMS results:

```json
POST /api/control/sms-result
{
  "message_id": "msg-123",
  "success": true,
  "error_message": null,
  "sms_id": "12345"
}
```

The database will update the message with:
- `status`: 'sent' or 'failed' depending on success
- `error_message`: Error details if the SMS failed to send
- `sms_id`: ModemManager SMS ID for tracking
- `updated_at`: Current timestamp

## Note

This issue occurred because migration `009_fix_messages_foreign_key.sql` was never applied to the production database. That migration included these columns in its schema definition but was apparently skipped during deployment.

## Prevention

Going forward, ensure all migration files are executed on the production database after creation. The migration history should be tracked to avoid missing schema updates.
