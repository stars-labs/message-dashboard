import { describe, expect, test } from 'bun:test';
import { cacheControlFor } from './asset-cache-control.js';

describe('static asset cache-control', () => {
  test('hashed build output is immutable for a year', () => {
    expect(cacheControlFor('/assets/index-DFrFb-gv.js')).toBe(
      'public, max-age=31536000, immutable',
    );
    expect(cacheControlFor('/assets/index-a1b2c3d4.css')).toBe(
      'public, max-age=31536000, immutable',
    );
  });

  test('sw.js must be revalidated, never immutable', () => {
    // An immutable sw.js could never be updated or killed.
    expect(cacheControlFor('/sw.js')).toBe('no-cache');
  });

  test('the manifest must be revalidated', () => {
    expect(cacheControlFor('/manifest.webmanifest')).toBe('no-cache');
  });

  test('HTML is never cached', () => {
    expect(cacheControlFor('/index.html')).toBe('no-cache');
  });

  test('workbox runtime emitted beside sw.js is also revalidated', () => {
    // Hashed name, but outside /assets/: the rule must not depend on the name.
    expect(cacheControlFor('/workbox-54d0af47.js')).toBe('no-cache');
  });

  test('root-level icons are revalidated rather than frozen', () => {
    expect(cacheControlFor('/icon-512.png')).toBe('no-cache');
    expect(cacheControlFor('/favicon.svg')).toBe('no-cache');
  });

  test('SPA routes with no extension are not cached', () => {
    expect(cacheControlFor('/dashboard')).toBe('no-cache');
  });
});
