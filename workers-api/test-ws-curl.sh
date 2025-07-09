#!/bin/bash

# Test WebSocket connection using curl
echo "Testing WebSocket upgrade..."

curl -v \
  -H "Connection: Upgrade" \
  -H "Upgrade: websocket" \
  -H "Sec-WebSocket-Version: 13" \
  -H "Sec-WebSocket-Key: SGVsbG8sIHdvcmxkIQ==" \
  'https://sms-dashboard.xiongchenyu6.workers.dev/api/ws?token=test-websocket-token-0JI4isnnSBD8Et09CchTp' 2>&1 | grep -E "(HTTP|error|Error|failed|Failed)"