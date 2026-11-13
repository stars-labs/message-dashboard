import { FRONTEND_ASSETS } from './frontend-assets.js';
import { cacheControlFor } from './asset-cache-control.js';
import type { AppRequest } from './worker-context.js';

export function serveFrontend(request: AppRequest): Response {
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

  // Remove leading slash for asset lookup
  const assetKey = pathname.startsWith('/') ? pathname.slice(1) : pathname;

  // Try to find the exact file
  let asset = FRONTEND_ASSETS[assetKey];

  console.log(`[Frontend Handler] Asset found: ${asset ? 'YES' : 'NO'}`);

  // If not found and no extension, try index.html (for SPA routing)
  if (!asset && !pathname.includes('.')) {
    asset = FRONTEND_ASSETS['index.html'];
  }

  // If still not found, return 404
  if (!asset) {
    return new Response('Not Found', { status: 404 });
  }

  // Prepare response body
  let body: Uint8Array | string;
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
  const headers: Record<string, string> = {
    'Content-Type': asset.type,
    'Cache-Control': cacheControlFor(pathname),
    'Access-Control-Allow-Origin': '*',
  };

  // Add additional headers for HTML to potentially bypass Cloudflare challenges
  if (asset.type === 'text/html') {
    headers['X-Content-Type-Options'] = 'nosniff';
    headers['X-Frame-Options'] = 'DENY';
  }

  const response = new Response(body as BodyInit, { headers });

  return response;
}
