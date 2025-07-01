#!/bin/bash
# Build script for Cloudflare Pages
# This handles any command line argument issues

echo "Building project..."
npm run build
echo "Build complete!"