#!/usr/bin/env bash

echo "🔐 Setting up Cloudflare Worker Secrets"
echo "======================================="
echo ""
echo "You'll need the following values from your old setup:"
echo "1. AUTH0_DOMAIN (e.g., your-tenant.auth0.com)"
echo "2. AUTH0_CLIENT_ID"
echo "3. AUTH0_CLIENT_SECRET"
echo "4. AUTH0_AUDIENCE (optional)"
echo "5. API_KEY (for Orange Pi authentication)"
echo ""

# AUTH0_DOMAIN
read -p "Enter AUTH0_DOMAIN: " auth0_domain
if [ ! -z "$auth0_domain" ]; then
    echo "$auth0_domain" | npx wrangler secret put AUTH0_DOMAIN
fi

# AUTH0_CLIENT_ID
read -p "Enter AUTH0_CLIENT_ID: " auth0_client_id
if [ ! -z "$auth0_client_id" ]; then
    echo "$auth0_client_id" | npx wrangler secret put AUTH0_CLIENT_ID
fi

# AUTH0_CLIENT_SECRET
read -p "Enter AUTH0_CLIENT_SECRET: " auth0_client_secret
if [ ! -z "$auth0_client_secret" ]; then
    echo "$auth0_client_secret" | npx wrangler secret put AUTH0_CLIENT_SECRET
fi

# AUTH0_AUDIENCE (optional)
read -p "Enter AUTH0_AUDIENCE (press Enter to skip): " auth0_audience
if [ ! -z "$auth0_audience" ]; then
    echo "$auth0_audience" | npx wrangler secret put AUTH0_AUDIENCE
fi

# API_KEY
read -p "Enter API_KEY for Orange Pi: " api_key
if [ ! -z "$api_key" ]; then
    echo "$api_key" | npx wrangler secret put API_KEY
fi

echo ""
echo "✅ Secrets have been set!"
echo ""
echo "Listing secrets to verify:"
npx wrangler secret list
