import { defineConfig } from 'vite'
import { svelte } from '@sveltejs/vite-plugin-svelte'

// https://vite.dev/config/
export default defineConfig({
  plugins: [svelte()],
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
