// Test harness for Svelte components under `bun test`.
//
// Two things have to happen before a `.svelte` import works here:
//
//  1. A DOM must exist. Bun's runtime is server-side, so `happy-dom` installs
//     window/document/etc. onto globalThis.
//  2. Bun must know how to load `.svelte` files. Bun has no built-in Svelte
//     loader, so we register a plugin that runs the Svelte compiler on demand.
//
// Loaded via the `preload` key in bunfig.toml, so every test file gets it.

import { GlobalRegistrator } from '@happy-dom/global-registrator';
import { plugin } from 'bun';
import { compile, compileModule } from 'svelte/compiler';
import { readFileSync } from 'node:fs';

GlobalRegistrator.register();

plugin({
  name: 'svelte',
  setup(build) {
    // `generate: 'client'` produces browser-targeted code, which is what we want
    // because happy-dom gives us a real DOM to mount into.
    build.onLoad({ filter: /\.svelte$/ }, ({ path }) => {
      const source = readFileSync(path, 'utf8');
      const { js } = compile(source, { filename: path, generate: 'client' });
      return { contents: js.code, loader: 'js' };
    });

    // `.svelte.js` modules may use runes at the top level, which requires the
    // compiler's module transform rather than plain JS evaluation. @testing-library
    // ships one of these itself (props.svelte.js), so this branch is load-bearing
    // even before any of our own code uses the extension.
    build.onLoad({ filter: /\.svelte\.js$/ }, ({ path }) => {
      const source = readFileSync(path, 'utf8');
      const { js } = compileModule(source, { filename: path, generate: 'client' });
      return { contents: js.code, loader: 'js' };
    });
  },
});
