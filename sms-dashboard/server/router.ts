const METHODS = ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'] as const;

type Method = (typeof METHODS)[number];

/** What the router reads from a request, and the parameters it writes back. */
export interface RoutedRequest {
  url: string;
  method: string;
  params?: Record<string, string>;
}

/** A route handler. Returning a Response short-circuits; null/undefined continues. */
export type RouteHandler<Request> = (
  request: Request,
) => Promise<Response | null | undefined> | Response | null | undefined;

interface Route<Request> {
  path: string;
  handlers: RouteHandler<Request>[];
}

function decodeSegment(segment: string): string {
  // Decode: `pathname` keeps percent-encoding, and Auth0 user ids contain
  // '|' (auth0|abc -> auth0%7Cabc). Passing the raw segment on meant it got
  // encoded a second time downstream (auth0%257Cabc), addressing the wrong
  // user. Malformed encoding falls back to the raw value rather than
  // throwing out of the router.
  try {
    return decodeURIComponent(segment);
  } catch {
    return segment;
  }
}

/**
 * The route parameters when `pattern` matches `pathname`, or null. A pattern is
 * a literal path, `*`, a `prefix*`, or a path with `:name` segments.
 */
export function matchRoute(pattern: string, pathname: string): Record<string, string> | null {
  if (pattern.includes(':')) {
    const patternParts = pattern.split('/');
    const pathParts = pathname.split('/');
    if (patternParts.length !== pathParts.length) return null;
    const params: Record<string, string> = {};
    for (const [index, part] of patternParts.entries()) {
      const segment = pathParts[index] ?? '';
      if (part.startsWith(':')) params[part.slice(1)] = decodeSegment(segment);
      else if (part !== segment) return null;
    }
    return params;
  }
  if (pattern === '*' || pattern === pathname) return {};
  if (pattern.endsWith('*') && pathname.startsWith(pattern.slice(0, -1))) return {};
  return null;
}

/**
 * Routes a request to the first route registered for its method whose path
 * matches. A route's handlers run in order until one returns a Response.
 */
export class Router<Request extends RoutedRequest> {
  private readonly routes: Record<Method, Route<Request>[]> = {
    GET: [],
    POST: [],
    PUT: [],
    DELETE: [],
    OPTIONS: [],
  };

  get(path: string, ...handlers: RouteHandler<Request>[]) {
    this.routes.GET.push({ path, handlers });
  }

  post(path: string, ...handlers: RouteHandler<Request>[]) {
    this.routes.POST.push({ path, handlers });
  }

  put(path: string, ...handlers: RouteHandler<Request>[]) {
    this.routes.PUT.push({ path, handlers });
  }

  delete(path: string, ...handlers: RouteHandler<Request>[]) {
    this.routes.DELETE.push({ path, handlers });
  }

  options(path: string, ...handlers: RouteHandler<Request>[]) {
    this.routes.OPTIONS.push({ path, handlers });
  }

  async handle(request: Request): Promise<Response | null | undefined> {
    const method = METHODS.find((candidate) => candidate === request.method);
    const pathname = new URL(request.url).pathname;

    for (const route of method ? this.routes[method] : []) {
      const params = matchRoute(route.path, pathname);
      if (!params) continue;
      if (route.path.includes(':')) request.params = params;

      // Execute handlers in sequence
      let response: Response | null | undefined;
      for (const handler of route.handlers) {
        response = await handler(request);
        if (response) break;
      }
      return response;
    }

    return null;
  }
}
