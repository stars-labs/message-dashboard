import { FRONTEND_ASSETS } from './frontend-assets.js';

export function serveFrontend(request) {
  const url = new URL(request.url);
  let pathname = url.pathname;
  
  // Remove trailing slash
  if (pathname.endsWith('/') && pathname !== '/') {
    pathname = pathname.slice(0, -1);
  }
  
  // Default to index.html for root
  if (pathname === '/') {
    pathname = '/index.html';
  }
  
  // Try to find the exact file
  let asset = FRONTEND_ASSETS[pathname.slice(1)]; // Remove leading slash
  
  // If not found and no extension, try index.html (for SPA routing)
  if (!asset && !pathname.includes('.')) {
    asset = FRONTEND_ASSETS['index.html'];
  }
  
  // If still not found, return 404
  if (!asset) {
    return new Response('Not Found', { status: 404 });
  }
  
  // Prepare response body
  let body;
  if (asset.encoding === 'base64') {
    // Decode base64 for binary files
    const binaryString = atob(asset.content);
    const bytes = new Uint8Array(binaryString.length);
    for (let i = 0; i < binaryString.length; i++) {
      bytes[i] = binaryString.charCodeAt(i);
    }
    body = bytes;
  } else {
    body = asset.content;
  }
  
  // Return the asset with appropriate headers
  return new Response(body, {
    headers: {
      'Content-Type': asset.type,
      'Cache-Control': pathname.includes('.') && !pathname.endsWith('.html') 
        ? 'public, max-age=31536000, immutable' // Cache static assets for 1 year
        : 'no-cache', // Don't cache HTML
    },
  });
}