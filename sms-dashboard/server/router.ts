const METHODS = ['GET', 'OPTIONS'] as const;

type Method = (typeof METHODS)[number];

// Null or undefined means the route does not answer this request.
type RouteHandler<Request> = (
  request: Request,
) => Promise<Response | null | undefined> | Response | null | undefined;

interface Route<Request> {
  path: string;
  handler: RouteHandler<Request>;
}

// Routes outside the contract. A path is a literal or `*`; the first registered match wins.
export class Router<Request extends { url: string; method: string }> {
  private readonly table: Record<Method, Route<Request>[]> = { GET: [], OPTIONS: [] };

  get(path: string, handler: RouteHandler<Request>) {
    this.table.GET.push({ path, handler });
  }

  options(path: string, handler: RouteHandler<Request>) {
    this.table.OPTIONS.push({ path, handler });
  }

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
