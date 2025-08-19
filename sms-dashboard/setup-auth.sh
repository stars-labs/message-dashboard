#!/bin/bash

echo "🔐 Cloudflare Authentication Setup"
echo "=================================="
echo ""
echo "Choose authentication method:"
echo "1) OAuth Login (opens browser)"
echo "2) API Token (manual setup)"
echo ""
read -p "Enter choice [1-2]: " choice

case $choice in
    1)
        echo "Starting OAuth login..."
        npx wrangler login
        
        # Test the login
        echo ""
        echo "Testing authentication..."
        npx wrangler whoami
        ;;
        
    2)
        echo ""
        echo "📋 API Token Setup Instructions:"
        echo "1. Go to: https://dash.cloudflare.com/profile/api-tokens"
        echo "2. Click 'Create Token'"
        echo "3. Use 'Custom token' template"
        echo "4. Set these permissions:"
        echo "   - Account > D1 > Edit"
        echo "   - Account > Workers KV Storage > Edit"
        echo "   - Account > Workers Scripts > Edit"
        echo "   - Account > Workers Tail > Read"
        echo "   - Account > Cloudflare AI > Edit"
        echo "   - Account > Account Settings > Read"
        echo "   - Zone > Zone > Read (if using custom domain)"
        echo "5. Copy the token"
        echo ""
        read -p "Enter your API token: " token
        
        # Set the token
        export CLOUDFLARE_API_TOKEN="$token"
        
        # Save to .env file for persistence
        echo "CLOUDFLARE_API_TOKEN=$token" > .env.local
        
        echo ""
        echo "✅ Token saved to .env.local"
        echo ""
        echo "Testing authentication..."
        CLOUDFLARE_API_TOKEN="$token" npx wrangler whoami
        
        echo ""
        echo "To use this token in future sessions, run:"
        echo "export CLOUDFLARE_API_TOKEN='$token'"
        echo "Or source the .env.local file:"
        echo "source .env.local"
        ;;
        
    *)
        echo "Invalid choice"
        exit 1
        ;;
esac

echo ""
echo "✅ Authentication setup complete!"