#!/bin/bash

# Verify that the SMS result endpoint is working correctly

echo "Testing SMS result endpoint..."
echo ""

# You would need to replace these with actual values
MESSAGE_ID="test-msg-123"
API_KEY="your-api-key-here"

curl -X POST https://sexy.qzz.io/api/control/sms-result \
  -H "Content-Type: application/json" \
  -H "X-API-Key: $API_KEY" \
  -d '{
    "message_id": "'$MESSAGE_ID'",
    "success": true,
    "error_message": null,
    "sms_id": "12345"
  }' | jq

echo ""
echo "If you see a 500 error, check the Cloudflare Workers logs with:"
echo "npx wrangler tail sms-dashboard --format pretty"
