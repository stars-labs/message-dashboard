// Kept apart from frontend-handler.ts, which imports the gitignored generated
// frontend-assets.js and so cannot be imported by a test in a clean checkout.
//
// Only Vite's hashed /assets/ files may be immutable. sw.js, the manifest, icons and
// HTML keep a fixed name while their contents change, so they are revalidated.

const IMMUTABLE = 'public, max-age=31536000, immutable';
const REVALIDATE = 'no-cache';

export function cacheControlFor(pathname: string): string {
  return pathname.startsWith('/assets/') ? IMMUTABLE : REVALIDATE;
}
