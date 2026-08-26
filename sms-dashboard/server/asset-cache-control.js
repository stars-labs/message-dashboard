// Cache-Control policy for the frontend assets inlined into the Worker.
//
// Split out of frontend-handler.js so it can be unit tested: that module imports
// the generated (and gitignored) frontend-assets.js, so importing it from a test
// works locally and fails in a clean checkout.
//
// Only content-addressed files may be immutable. Vite writes hashed names into
// /assets/, so a byte change produces a new URL and a stale copy is unreachable.
// Everything else — sw.js, the manifest, icons, HTML — keeps a fixed name while its
// contents change between releases, so those must be revalidated on every request.
//
// `no-cache` does not mean "don't store": the client may cache but must check with
// the origin (via ETag) before reusing. That is exactly the semantics a service
// worker needs — without it an immutable sw.js could never be updated or killed.

const IMMUTABLE = 'public, max-age=31536000, immutable';
const REVALIDATE = 'no-cache';

/** Cache-Control header value for a request pathname (leading slash included). */
export function cacheControlFor(pathname) {
  return pathname.startsWith('/assets/') ? IMMUTABLE : REVALIDATE;
}
