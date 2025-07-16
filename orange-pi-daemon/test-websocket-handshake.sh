#!/bin/sh

# Test WebSocket handshake with Authorization header

API_KEY="${SMS_API_KEY:-your-secure-api-key-here}"
HOST="sexy.qzz.io"
PATH="/api/daemon-ws"

echo "Testing WebSocket handshake to wss://${HOST}${PATH}"
echo "Using API Key: ${API_KEY:0:10}..."

# Generate WebSocket key
WS_KEY=$(openssl rand -base64 16)

# Create handshake request
cat <<EOF | openssl s_client -connect ${HOST}:443 -servername ${HOST} -quiet 2>/dev/null
GET ${PATH} HTTP/1.1
Host: ${HOST}
Upgrade: websocket
Connection: Upgrade
Sec-WebSocket-Key: ${WS_KEY}
Sec-WebSocket-Version: 13
Authorization: Bearer ${API_KEY}

EOF