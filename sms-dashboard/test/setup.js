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

// Svelte's transition directives call element.animate() unconditionally, and
// these tests assert on DOM state, never on animation progress, so a no-op
// Animation replaces whatever the DOM offers. happy-dom gained a real
// implementation in 21.x whose `finished` promise rejects with AbortError when
// Svelte cancels a transition on unmount; nothing awaits that promise, so bun
// reported it as an unhandled error between tests. Older happy-dom had no
// animate() at all and printed "element.animate is not a function" instead.
if (typeof globalThis.Element !== 'undefined') {
  globalThis.Element.prototype.animate = function animate() {
    return {
      cancel() {},
      finish() {},
      play() {},
      pause() {},
      reverse() {},
      currentTime: 0,
      playState: 'finished',
      finished: Promise.resolve(),
      onfinish: null,
      oncancel: null,
    };
  };
}

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
