import { FRONTEND_ASSETS } from './frontend-assets.js';

export function serveFrontend(request) {
  const url = new URL(request.url);
  let pathname = url.pathname;
  
  console.log(`[Frontend Handler] Request URL: ${url.href}`);
  console.log(`[Frontend Handler] Original pathname: ${pathname}`);
  
  // Remove trailing slash
  if (pathname.endsWith('/') && pathname !== '/') {
    pathname = pathname.slice(0, -1);
  }
  
  // Default to index.html for root
  if (pathname === '/') {
    pathname = '/index.html';
  }
  
  console.log(`[Frontend Handler] Normalized pathname: ${pathname}`);
  
  // Remove leading slash for asset lookup
  const assetKey = pathname.startsWith('/') ? pathname.slice(1) : pathname;
  
  console.log(`[Frontend Handler] Asset key: ${assetKey}`);
  
  // Try to find the exact file
  let asset = FRONTEND_ASSETS[assetKey];
  
  console.log(`[Frontend Handler] Asset found: ${asset ? 'YES' : 'NO'}`);
  
  // If not found and no extension, try index.html (for SPA routing)
  if (!asset && !pathname.includes('.')) {
    console.log(`[Frontend Handler] No extension found, falling back to index.html`);
    asset = FRONTEND_ASSETS['index.html'];
  }
  
  // If still not found, return 404
  if (!asset) {
    console.log(`[Frontend Handler] Asset not found, returning 404`);
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
  const headers = {
    'Content-Type': asset.type,
    'Cache-Control': pathname.includes('.') && !pathname.endsWith('.html') 
      ? 'public, max-age=31536000, immutable' // Cache static assets for 1 year
      : 'no-cache', // Don't cache HTML
    'Access-Control-Allow-Origin': '*',
  };
  
  // Add additional headers for HTML to potentially bypass Cloudflare challenges
  if (asset.type === 'text/html') {
    headers['X-Content-Type-Options'] = 'nosniff';
    headers['X-Frame-Options'] = 'DENY';
  }
  
  const response = new Response(body, { headers });
  
  console.log(`[Frontend Handler] Returning ${pathname} with Content-Type: ${asset.type}`);
  console.log(`[Frontend Handler] Response body length: ${body.length || body.byteLength || 0}`);
  return response;
}