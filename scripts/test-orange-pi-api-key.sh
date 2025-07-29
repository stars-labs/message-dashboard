#!/bin/bash
# Test script to diagnose API key issues on Orange Pi

echo "=== Testing Orange Pi SMS Daemon API Key Configuration ==="
echo

# Check if the API key file exists
API_KEY_FILE="/run/secrets/sms-dashboard/api-key"
echo "1. Checking API key file existence:"
if [ -f "$API_KEY_FILE" ]; then
    echo "   ✓ API key file exists at $API_KEY_FILE"
    
    # Check file permissions
    echo "   File permissions: $(ls -la $API_KEY_FILE)"
    
    # Check file content (show length and first few chars)
    API_KEY_CONTENT=$(cat "$API_KEY_FILE" 2>/dev/null)
    if [ $? -eq 0 ]; then
        API_KEY_LENGTH=${#API_KEY_CONTENT}
        echo "   API key length: $API_KEY_LENGTH characters"
        echo "   API key preview: ${API_KEY_CONTENT:0:8}..."
        
        # Check for newlines
        if [[ "$API_KEY_CONTENT" == *$'\n'* ]]; then
            echo "   ⚠️  WARNING: API key contains newline characters!"
        fi
        
        # Check for whitespace
        TRIMMED_KEY=$(echo -n "$API_KEY_CONTENT" | tr -d '[:space:]')
        if [ "$API_KEY_CONTENT" != "$TRIMMED_KEY" ]; then
            echo "   ⚠️  WARNING: API key contains whitespace!"
        fi
    else
        echo "   ✗ Cannot read API key file (permission denied?)"
    fi
else
    echo "   ✗ API key file does not exist at $API_KEY_FILE"
fi

echo
echo "2. Testing API key with curl:"
# Try with the key from file
if [ -f "$API_KEY_FILE" ]; then
    API_KEY=$(cat "$API_KEY_FILE" | tr -d '\n')
    echo "   Testing API endpoint with key from file..."
    
    RESPONSE=$(curl -s -w "\nHTTP_CODE:%{http_code}" \
        -X GET \
        -H "X-API-Key: $API_KEY" \
        -H "Content-Type: application/json" \
        https://sexy.qzz.io/api/control/pending-sms)
    
    HTTP_CODE=$(echo "$RESPONSE" | grep "HTTP_CODE:" | cut -d: -f2)
    BODY=$(echo "$RESPONSE" | sed '/HTTP_CODE:/d')
    
    echo "   HTTP Status: $HTTP_CODE"
    if [ "$HTTP_CODE" = "200" ]; then
        echo "   ✓ API key is valid!"
    elif [ "$HTTP_CODE" = "401" ]; then
        echo "   ✗ API key is invalid (401 Unauthorized)"
    else
        echo "   ? Unexpected status code"
    fi
    echo "   Response preview: ${BODY:0:100}..."
fi

echo
echo "3. Checking systemd service:"
echo "   Service status:"
systemctl status sms-daemon.service --no-pager | head -10

echo
echo "4. Recent daemon logs:"
journalctl -u sms-daemon.service -n 20 --no-pager

echo
echo "=== End of diagnostics ==="