import { describe, expect, test } from 'bun:test';
import { cacheControlFor } from './asset-cache-control.js';

// The old rule was `pathname.includes('.') && !endsWith('.html')` → immutable for a
// year. That silently covered /sw.js and /manifest.webmanifest, which are
// fixed-name files whose contents change on every release. A year-long immutable
// TTL on a service worker means no update and no kill-switch — the reason these
// tests exist.
describe('static asset cache-control', () => {
  test('hashed build output is immutable for a year', () => {
    // Vite emits content-addressed names, so the URL changes when the bytes do.
    expect(cacheControlFor('/assets/index-DFrFb-gv.js')).toBe(
      'public, max-age=31536000, immutable',
    );
    expect(cacheControlFor('/assets/index-a1b2c3d4.css')).toBe(
      'public, max-age=31536000, immutable',
    );
  });

  test('sw.js must be revalidated, never immutable', () => {
    // Core regression: an immutable sw.js cannot be updated or killed remotely.
    expect(cacheControlFor('/sw.js')).toBe('no-cache');
  });

  test('the manifest must be revalidated', () => {
    expect(cacheControlFor('/manifest.webmanifest')).toBe('no-cache');
  });

  test('HTML is never cached', () => {
    expect(cacheControlFor('/index.html')).toBe('no-cache');
  });

  test('workbox runtime emitted beside sw.js is also revalidated', () => {
    // vite-plugin-pwa may emit workbox-*.js at the root. Those names do contain a
    // hash, but they live outside /assets/, so the rule must not depend on the
    // filename looking hashed.
    expect(cacheControlFor('/workbox-54d0af47.js')).toBe('no-cache');
  });

  test('root-level icons are revalidated rather than frozen', () => {
    // Icons are referenced by fixed name from the manifest, so replacing one has
    // to be able to take effect.
    expect(cacheControlFor('/icon-512.png')).toBe('no-cache');
    expect(cacheControlFor('/favicon.svg')).toBe('no-cache');
  });

  test('SPA routes with no extension are not cached', () => {
    expect(cacheControlFor('/dashboard')).toBe('no-cache');
  });
});
