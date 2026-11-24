const HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization, X-API-Key, Upgrade, Connection',
  'Access-Control-Allow-Credentials': 'true',
  'Access-Control-Max-Age': '86400',
};

export function handleCORS(response?: Response | null): Response {
  if (response instanceof Response) {
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

  return new Response(null, {
    status: 204,
    headers: HEADERS,
  });
}

export const corsPreflight = (): Response => handleCORS();
