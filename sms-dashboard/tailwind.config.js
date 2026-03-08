/** @type {import('tailwindcss').Config} */
export default {
  content: [
    "./index.html",
    "./client/**/*.{svelte,js,ts,jsx,tsx}",
  ],
  safelist: [
    'bg-gradient-to-r',
    'from-purple-500', 'to-indigo-500',
    'from-purple-600', 'to-indigo-600',
    'from-green-500', 'to-green-600',
    'from-red-500', 'to-red-600',
  ],
  theme: {
    extend: {},
  },
  plugins: [
    require('@tailwindcss/forms'),
  ],
}