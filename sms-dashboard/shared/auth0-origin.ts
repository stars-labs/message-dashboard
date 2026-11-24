// A loopback domain is a local stand-in for the tenant (scripts/e2e/fake-auth0.ts);
// Auth0 itself serves only HTTPS. The Worker and the Balance Agent both obey this.
export function auth0Origin(domain: string): string {
  const loopback = /^(localhost|127\.0\.0\.1)(:\d+)?$/.test(domain);
  return `${loopback ? 'http' : 'https'}://${domain}`;
}
