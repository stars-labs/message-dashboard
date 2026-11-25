import { FRONTEND_ASSETS } from './frontend-assets.js';
import { cacheControlFor } from './asset-cache-control.js';

export function serveFrontend(request: { url: string }): Response {
  const url = new URL(request.url);
  let pathname = url.pathname;

  if (pathname.endsWith('/') && pathname !== '/') {
    pathname = pathname.slice(0, -1);
  }

  if (pathname === '/') {
    pathname = '/index.html';
  }

  const assetKey = pathname.startsWith('/') ? pathname.slice(1) : pathname;

  let asset = FRONTEND_ASSETS[assetKey];

  console.log(`[Frontend Handler] Asset found: ${asset ? 'YES' : 'NO'}`);

  // SPA routing: an extensionless miss serves index.html.
  if (!asset && !pathname.includes('.')) {
    asset = FRONTEND_ASSETS['index.html'];
  }

  if (!asset) {
    return new Response('Not Found', { status: 404 });
  }

  let body: Uint8Array<ArrayBuffer> | string;
  if (asset.encoding === 'base64') {
    const binaryString = atob(asset.content);
    const bytes = new Uint8Array(binaryString.length);
    for (let i = 0; i < binaryString.length; i++) {
      bytes[i] = binaryString.charCodeAt(i);
    }
    body = bytes;
  } else {
    body = asset.content;
  }

  const headers = new Headers({
    'Content-Type': asset.type,
    'Cache-Control': cacheControlFor(pathname),
  });

  if (asset.type === 'text/html') {
    headers.set('X-Content-Type-Options', 'nosniff');
    headers.set('X-Frame-Options', 'DENY');
  }

  const response = new Response(body, { headers });

  return response;
}
