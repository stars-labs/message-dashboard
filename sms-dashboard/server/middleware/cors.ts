// CORS middleware
//
// Two call shapes, deliberately kept separate: `handleCORS` wraps a Response (or
// answers a preflight when given nothing), and `corsPreflight` is the adapter the
// router needs, since a route handler is invoked with (request, env, ctx).

const HEADERS = {
  'Access-Control-Allow-Origin': '*', // Allow all origins for WebSocket compatibility
  'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization, X-API-Key, Upgrade, Connection',
  'Access-Control-Allow-Credentials': 'true',
  'Access-Control-Max-Age': '86400',
};

export function handleCORS(response?: Response | null): Response {
  if (response instanceof Response) {
    // Add CORS headers to existing response
    const headers = new Headers(response.headers);
    Object.entries(HEADERS).forEach(([key, value]) => {
      headers.set(key, value);
    });
    return new Response(response.body, {
      status: response.status,
      statusText: response.statusText,
      headers,
    });
  }

  // OPTIONS request
  return new Response(null, {
    status: 204,
    headers: HEADERS,
  });
}

/** Router adapter for OPTIONS '*'. */
export const corsPreflight = (): Response => handleCORS();
