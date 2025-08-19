#!/bin/bash

echo "🔐 Setting up Cloudflare API Token for D1 Access"
echo "================================================"
echo ""
echo "Step 1: Create an API Token"
echo "1. Go to: https://dash.cloudflare.com/profile/api-tokens"
echo "2. Click 'Create Token'"
echo "3. Select 'Create Custom Token'"
echo "4. Configure as follows:"
echo ""
echo "Token name: D1 Migration Token"
echo ""
echo "Permissions:"
echo "  • Account - D1:Edit"
echo "  • Account - Workers KV Storage:Edit"  
echo "  • Account - Workers Scripts:Edit"
echo "  • Account - Cloudflare Workers AI:Edit"
echo "  • Account - Account Settings:Read"
echo ""
echo "Account Resources:"
echo "  • Include - Your Account (Freemanx@bitgc.io's Account)"
echo ""
echo "5. Click 'Continue to summary'"
echo "6. Click 'Create Token'"
echo "7. COPY THE TOKEN (you won't see it again!)"
echo ""
read -p "Paste your API token here: " token

if [ -z "$token" ]; then
    echo "No token provided"
    exit 1
fi

# Save to .env file
echo "CLOUDFLARE_API_TOKEN=$token" > .env

echo ""
echo "✅ Token saved to .env file"
echo ""
echo "Testing with API token..."
CLOUDFLARE_API_TOKEN="$token" npx wrangler whoami

echo ""
echo "Testing D1 access..."
CLOUDFLARE_API_TOKEN="$token" npx wrangler d1 execute sms-dashboard --command="SELECT 1 as test" --remote

echo ""
echo "To use this token for all commands, run:"
echo "export CLOUDFLARE_API_TOKEN='$token'"
