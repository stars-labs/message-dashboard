// CORS middleware
export function handleCORS(response) {
  const headers = {
    'Access-Control-Allow-Origin': '*', // Allow all origins for WebSocket compatibility
    'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization, X-API-Key, Upgrade, Connection',
    'Access-Control-Allow-Credentials': 'true',
    'Access-Control-Max-Age': '86400',
  };
  
  if (response instanceof Response) {
    // Add CORS headers to existing response
    const newHeaders = new Headers(response.headers);
    Object.entries(headers).forEach(([key, value]) => {
      newHeaders.set(key, value);
    });
    return new Response(response.body, {
      status: response.status,
      statusText: response.statusText,
      headers: newHeaders
    });
  } else {
    // OPTIONS request
    return new Response(null, {
      status: 204,
      headers
    });
  }
}