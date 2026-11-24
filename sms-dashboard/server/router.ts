const METHODS = ['GET', 'OPTIONS'] as const;

type Method = (typeof METHODS)[number];

/** A route handler. Null or undefined means the route does not answer this request. */
type RouteHandler<Request> = (
  request: Request,
) => Promise<Response | null | undefined> | Response | null | undefined;

interface Route<Request> {
  path: string;
  handler: RouteHandler<Request>;
}

/**
 * The routes outside the contract: browser redirects, the app shell and CORS
 * preflight. A path is a literal or `*`. A request goes to the first route
 * registered for its method whose path matches.
 */
export class Router<Request extends { url: string; method: string }> {
  private readonly table: Record<Method, Route<Request>[]> = { GET: [], OPTIONS: [] };

  get(path: string, handler: RouteHandler<Request>) {
    this.table.GET.push({ path, handler });
  }

  options(path: string, handler: RouteHandler<Request>) {
    this.table.OPTIONS.push({ path, handler });
  }

  /** Every registered route, grouped by method, each method in the order it dispatches. */
  routes(): { method: Method; path: string }[] {
    return METHODS.flatMap((method) => this.table[method].map(({ path }) => ({ method, path })));
  }

  async handle(request: Request): Promise<Response | null | undefined> {
    const method = METHODS.find((candidate) => candidate === request.method);
    const { pathname } = new URL(request.url);
    const route = (method ? this.table[method] : []).find(
      ({ path }) => path === '*' || path === pathname,
    );
    return route ? await route.handler(request) : null;
  }
}
