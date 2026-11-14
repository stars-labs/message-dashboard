import type { AcceptedPlugin } from 'postcss';
import autoprefixer from 'autoprefixer';
import tailwindcss from 'tailwindcss';

export default {
  plugins: [tailwindcss(), autoprefixer()],
} satisfies { plugins: AcceptedPlugin[] };
