/** @type {import('tailwindcss').Config} */
export default {
  content: [
    "./index.html",
    "./src/**/*.{svelte,js,ts,jsx,tsx}",
  ],
  safelist: [
    {
      pattern: /^(from|to|via)-(red|green|blue|indigo|purple|pink|gray|yellow|orange|sky)-(400|500|600|700|800|900)$/,
    },
    {
      pattern: /^bg-gradient-to-(r|l|t|b|br|bl|tr|tl)$/,
    }
  ],
  theme: {
    extend: {},
  },
  plugins: [
    require('@tailwindcss/forms'),
  ],
}