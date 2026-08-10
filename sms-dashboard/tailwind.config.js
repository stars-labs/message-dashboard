/** @type {import('tailwindcss').Config} */
export default {
  content: [
    "./index.html",
    "./client/**/*.{svelte,js,ts,jsx,tsx}",
  ],
  // Safelist only what Tailwind genuinely cannot find by scanning source text —
  // class names assembled at runtime from data. The purple gradient classes were
  // here for the old MessageComposer send button; Stage 6 replaces that button
  // with the design-system orange, so they can go once that ships.
  safelist: [
    'bg-gradient-to-r',
    'from-purple-500', 'to-indigo-500',
    'from-purple-600', 'to-indigo-600',
    'from-green-500', 'to-green-600',
    'from-red-500', 'to-red-600',
  ],
  theme: {
    extend: {
      // Design tokens from the handoff's "Design Tokens" section.
      // Only values that Tailwind's default palette doesn't cover exactly are
      // added here; standard stone/orange/emerald/amber/red ramps are already
      // present and are used directly.
      colors: {
        // Page / surface
        'page-bg':   '#F7F5F2',
        'card':      '#FFFFFF',
        'card-alt':  '#FAFAF9',
        // Borders
        'border':    '#E7E5E4',
        'border-input': '#D6D3D1',
        'divider':   '#F5F5F4',
        // Brand action (primary orange)
        'action':        '#F97316',
        'action-hover':  '#EA580C',
        'action-text':   '#C2410C',
        'action-bg':     '#FFF7ED',
        'action-border': '#FED7AA',
      },
      boxShadow: {
        'card':    '0 1px 2px rgba(28,25,23,.04)',
        'raised':  '0 1px 3px rgba(28,25,23,.06)',
        'focus':   '0 2px 10px rgba(249,115,22,.10)',
        'drawer':  '-16px 0 40px rgba(28,25,23,.16)',
        'modal':   '0 24px 60px rgba(28,25,23,.28)',
        'sheet':   '0 -8px 30px rgba(28,25,23,.18)',
        'ring':    '0 0 0 3px rgba(249,115,22,.12)',
      },
      fontFamily: {
        // These are already loaded via app.css @import — extending here lets
        // Tailwind generate `font-mono` and `font-sans` from the same source.
        sans: ["'IBM Plex Sans'", 'system-ui', 'sans-serif'],
        mono: ["'IBM Plex Mono'", "'Fira Code'", 'monospace'],
      },
    },
  },
  plugins: [
    require('@tailwindcss/forms'),
  ],
}