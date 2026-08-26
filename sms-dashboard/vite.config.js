import { defineConfig } from 'vite'
import { svelte } from '@sveltejs/vite-plugin-svelte'
import { VitePWA } from 'vite-plugin-pwa'

// https://vite.dev/config/
export default defineConfig({
  plugins: [
    svelte(),
    VitePWA({
      // 'prompt', not 'autoUpdate': the new worker waits until the user accepts.
      // See client/lib/sw-update.js for why a silent takeover is wrong here.
      registerType: 'prompt',

      // The manifest is hand-written at public/manifest.webmanifest and linked from
      // index.html. Letting the plugin emit a second one would create two sources of
      // truth for the install metadata.
      manifest: false,

      workbox: {
        // Precache the hashed build output and the icons only. Note the absence of
        // `html`: `/` and `/index.html` are server-side auth gates (server/index.js
        // :614-648 redirects to /login without a valid session), so a cached shell
        // would let an expired session render the app instead of re-authenticating.
        globPatterns: ['**/*.{js,css,svg,png,ico}'],

        // For the same reason there is no navigation fallback. Navigations always hit
        // the network, so the Worker's redirect stays authoritative. The cost is that
        // the app will not open fully offline — acceptable, because every screen is
        // driven by /api/* data that is not cached either.
        navigateFallback: null,

        // Never cache the API. This is a deliberate, product-specific decision:
        //
        //  - client/lib/message-cache.js is already an IndexedDB layer for this data
        //    and its DB_VERSION has been forced to 4 by three separate stale-cache
        //    incidents (spam filter appearing broken, stale year values, wrong
        //    verification codes). A second cache layer would reproduce those bugs
        //    somewhere much harder to flush.
        //  - /api/messages returns full SMS bodies and verification codes, and Cache
        //    Storage is not partitioned by login session. On a shared device an
        //    ADMIN's cached responses would be readable by the next VIEWER.
        runtimeCaching: [],

        // Keep the SW and its runtime out of their own precache manifest.
        globIgnores: ['**/sw*', '**/workbox-*'],
      },
    }),
  ],
  base: '/',
  server: {
    port: 8080,
    host: '0.0.0.0',
    // Forward API and auth routes to the local Worker (`dev-api`, port 8787).
    // Without this, Vite answers /api/* with the SPA fallback index.html, so every
    // fetch in the app gets HTML and a misleading 200 instead of JSON.
    //
    // `changeOrigin` is left at its default of false on purpose: the Worker builds
    // its Auth0 redirect_uri from the request origin (server/handlers/auth0.js:14),
    // so preserving `Host: localhost:8080` keeps the whole login flow — and the
    // session cookie — on the same origin the SPA is served from.
    proxy: Object.fromEntries(
      ['/api', '/login', '/callback', '/logout'].map((path) => [
        path,
        { target: 'http://localhost:8787' },
      ])
    )
  },
  build: {
    outDir: 'dist',
    assetsDir: 'assets',
    rollupOptions: {
      output: {
        manualChunks: undefined
      }
    }
  }
})
