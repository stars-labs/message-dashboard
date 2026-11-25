// Null or undefined means the route does not answer this request.
type RouteHandler<Request> = (
  request: Request,
) => Promise<Response | null | undefined> | Response | null | undefined;

interface Route<Request> {
  path: string;
  handler: RouteHandler<Request>;
}

// GET routes outside the contract. A path is a literal or `*`; the first registered match wins.
export class Router<Request extends { url: string; method: string }> {
  private readonly table: Route<Request>[] = [];

  get(path: string, handler: RouteHandler<Request>) {
    this.table.push({ path, handler });
  }

  routes(): { method: 'GET'; path: string }[] {
    return this.table.map(({ path }) => ({ method: 'GET', path }));
  }

  async handle(request: Request): Promise<Response | null | undefined> {
    if (request.method !== 'GET') return null;
    const { pathname } = new URL(request.url);
    const route = this.table.find(({ path }) => path === '*' || path === pathname);
    return route ? await route.handler(request) : null;
  }
}
