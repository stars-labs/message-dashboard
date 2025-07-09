#!/bin/bash

# Deploy frontend to Cloudflare Pages

echo "🚀 Deploying frontend to Cloudflare Pages..."

# Check if dist directory exists
if [ ! -d "dist" ]; then
    echo "❌ dist directory not found. Run 'npm run build' first."
    exit 1
fi

# Deploy to Cloudflare Pages
echo "📦 Uploading to Cloudflare Pages..."
npx wrangler pages deploy dist \
    --project-name=sexy-qzz-io \
    --branch=main

echo "✅ Deployment complete!"
echo ""
echo "📌 Next steps:"
echo "1. Go to Cloudflare Pages dashboard"
echo "2. Add custom domain: sexy.qzz.io"
echo "3. Configure DNS records:"
echo "   - Type: CNAME"
echo "   - Name: @ (or sexy if it's a subdomain)"
echo "   - Target: sexy-qzz-io.pages.dev"
echo ""
echo "🔗 Your site will be available at:"
echo "   https://sexy-qzz-io.pages.dev (immediately)"
echo "   https://sexy.qzz.io (after DNS configuration)"