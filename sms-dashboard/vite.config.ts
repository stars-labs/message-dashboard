import { defineConfig } from 'vite';
import { svelte } from '@sveltejs/vite-plugin-svelte';
import { VitePWA } from 'vite-plugin-pwa';

export default defineConfig({
  plugins: [
    svelte(),
    VitePWA({
      // 'prompt': the new worker waits until the user accepts (see client/lib/sw-update.ts).
      registerType: 'prompt',

      // The manifest is hand-written at public/manifest.webmanifest; a second one would
      // be a second source of truth.
      manifest: false,

      workbox: {
        // No `html` and no navigation fallback: `/` and `/index.html` are server-side auth
        // gates, so a cached shell would let an expired session render the app.
        globPatterns: ['**/*.{js,css,svg,png,ico}'],
        navigateFallback: null,

        // Never cache the API: client/lib/message-cache.ts already caches this data, and a
        // second layer would reproduce its stale-cache bugs. /api/messages also returns SMS
        // bodies and verification codes, and Cache Storage is not partitioned by login
        // session, so an ADMIN's responses would be readable by the next VIEWER.
        runtimeCaching: [],

        globIgnores: ['**/sw*', '**/workbox-*'],
      },
    }),
  ],
  base: '/',
  server: {
    port: 8080,
    host: '0.0.0.0',
    // `changeOrigin` stays false: the Worker builds its Auth0 redirect_uri from the request
    // origin, so the login flow and session cookie must stay on the SPA's origin.
    proxy: Object.fromEntries(
      ['/api', '/login', '/callback', '/logout'].map((path) => [
        path,
        { target: 'http://localhost:8787' },
      ]),
    ),
  },
  build: {
    outDir: 'dist',
    assetsDir: 'assets',
  },
});
