#!/bin/bash

echo "Building frontend assets..."
npm run build:unified

echo "Deploying unified worker..."
wrangler deploy

echo ""
echo "Deployment complete!"
echo ""
echo "==================================="
echo "IMPORTANT: Update Auth0 Settings"
echo "==================================="
echo ""
echo "1. Go to https://manage.auth0.com/"
echo "2. Navigate to Applications > Your App > Settings"
echo "3. Update the following URLs:"
echo ""
echo "Allowed Callback URLs:"
echo "https://sms-dashboard.xiongchenyu6.workers.dev/api/auth/callback"
echo ""
echo "Allowed Logout URLs:"
echo "https://sms-dashboard.xiongchenyu6.workers.dev"
echo ""
echo "Allowed Web Origins:"
echo "https://sms-dashboard.xiongchenyu6.workers.dev"
echo ""
echo "4. Save the changes"
echo ""
echo "==================================="
echo ""
echo "Your unified app will be available at:"
echo "https://sms-dashboard.xiongchenyu6.workers.dev"