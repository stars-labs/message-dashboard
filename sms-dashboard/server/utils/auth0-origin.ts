// A loopback domain is a local stand-in for the tenant (the e2e suite runs one);
// Auth0 itself serves only HTTPS.
export function auth0Origin(domain: string): string {
  const loopback = /^(localhost|127\.0\.0\.1)(:\d+)?$/.test(domain);
  return `${loopback ? 'http' : 'https'}://${domain}`;
}
