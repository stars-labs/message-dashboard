#!/bin/bash

# SMS Dashboard Deployment Script with SOPS
# This script decrypts secrets and deploys to Cloudflare Workers

set -e

echo "🔐 SMS Dashboard Deployment Script"
echo "================================="

# Check if SOPS is installed
if ! command -v sops &> /dev/null; then
    echo "❌ SOPS is not installed. Please install it first:"
    echo "   brew install sops (macOS)"
    echo "   or download from https://github.com/mozilla/sops/releases"
    exit 1
fi

# Check if encrypted secrets exist
if [ ! -f "secrets.enc.yaml" ]; then
    echo "❌ secrets.enc.yaml not found!"
    echo "   Encrypt your secrets first with:"
    echo "   sops -e secrets.yaml > secrets.enc.yaml"
    exit 1
fi

echo "🔓 Decrypting secrets..."
# Decrypt secrets to temporary file
TEMP_SECRETS=$(mktemp)
trap "rm -f $TEMP_SECRETS" EXIT
sops -d secrets.enc.yaml > "$TEMP_SECRETS"

# Extract values using yq or python
if command -v yq &> /dev/null; then
    # Using yq
    AUTH0_DOMAIN=$(yq eval '.auth0.domain' "$TEMP_SECRETS")
    AUTH0_CLIENT_ID=$(yq eval '.auth0.client_id' "$TEMP_SECRETS")
    AUTH0_CLIENT_SECRET=$(yq eval '.auth0.client_secret' "$TEMP_SECRETS")
    API_KEY=$(yq eval '.api_key' "$TEMP_SECRETS")
elif command -v python3 &> /dev/null; then
    # Using python as fallback
    AUTH0_DOMAIN=$(python3 -c "import yaml; print(yaml.safe_load(open('$TEMP_SECRETS'))['auth0']['domain'])")
    AUTH0_CLIENT_ID=$(python3 -c "import yaml; print(yaml.safe_load(open('$TEMP_SECRETS'))['auth0']['client_id'])")
    AUTH0_CLIENT_SECRET=$(python3 -c "import yaml; print(yaml.safe_load(open('$TEMP_SECRETS'))['auth0']['client_secret'])")
    API_KEY=$(python3 -c "import yaml; print(yaml.safe_load(open('$TEMP_SECRETS'))['api_key'])")
else
    echo "❌ Neither yq nor python3 with PyYAML found. Please install one of them."
    exit 1
fi

echo "📝 Setting Cloudflare secrets..."
# Set secrets in Cloudflare Workers
echo "$AUTH0_DOMAIN" | wrangler secret put AUTH0_DOMAIN
echo "$AUTH0_CLIENT_ID" | wrangler secret put AUTH0_CLIENT_ID
echo "$AUTH0_CLIENT_SECRET" | wrangler secret put AUTH0_CLIENT_SECRET
echo "$API_KEY" | wrangler secret put API_KEY

echo "🚀 Deploying to Cloudflare Workers..."
wrangler deploy

echo "✅ Deployment complete!"
echo ""
echo "📌 Important URLs:"
echo "   API: https://sms-dashboard-api.xiongchenyu6.workers.dev"
echo "   Frontend: https://sexy.qzz.io"
echo ""
echo "🔑 API Key for Orange Pi:"
echo "   $API_KEY"
echo ""
echo "⚠️  Don't forget to update Auth0 callback URLs!"