import { vitePreprocess, type SvelteConfig } from '@sveltejs/vite-plugin-svelte';

export default {
  preprocess: vitePreprocess(),
  // Legacy syntax (export let, $:, on:click) fails to compile. test/setup.ts reads this too.
  compilerOptions: { runes: true },
} satisfies SvelteConfig;
