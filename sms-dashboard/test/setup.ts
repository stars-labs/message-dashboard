// Preloaded for client tests only, by bunfig.client.toml: a DOM (happy-dom) and a Svelte loader.

import { GlobalRegistrator } from '@happy-dom/global-registrator';
import { plugin } from 'bun';
import { compile, compileModule } from 'svelte/compiler';
import { readFileSync } from 'node:fs';
import svelteConfig from '../svelte.config.ts';

GlobalRegistrator.register();

const noop = (): undefined => undefined;

// Svelte transitions call element.animate() unconditionally. happy-dom's real one
// rejects `finished` with AbortError when a transition is cancelled on unmount, which bun
// reports as an unhandled error, so a no-op replaces it.
if (typeof globalThis.Element !== 'undefined') {
  Object.defineProperty(globalThis.Element.prototype, 'animate', {
    value: function animate() {
      return {
        cancel: noop,
        finish: noop,
        play: noop,
        pause: noop,
        reverse: noop,
        currentTime: 0,
        playState: 'finished',
        finished: Promise.resolve(),
        onfinish: null,
        oncancel: null,
      };
    },
    writable: true,
    configurable: true,
  });
}

const jsTranspiler = new Bun.Transpiler({ loader: 'ts' });

plugin({
  name: 'svelte',
  setup(build) {
    build.onLoad({ filter: /\.svelte$/ }, ({ path }) => {
      const source = readFileSync(path, 'utf8');
      const { js } = compile(source, {
        ...svelteConfig.compilerOptions,
        filename: path,
        generate: 'client',
      });
      return { contents: js.code, loader: 'js' };
    });

    // Runes at module top level need compileModule; @testing-library ships props.svelte.js.
    build.onLoad({ filter: /\.svelte\.js$/ }, ({ path }) => {
      const source = readFileSync(path, 'utf8');
      const { js } = compileModule(source, { filename: path, generate: 'client' });
      return { contents: js.code, loader: 'js' };
    });

    // compileModule parses JavaScript only, and Bun's TS handling does not apply inside onLoad.
    build.onLoad({ filter: /\.svelte\.ts$/ }, ({ path }) => {
      const source = readFileSync(path, 'utf8');
      const code = jsTranspiler.transformSync(source);
      const { js } = compileModule(code, { filename: path, generate: 'client' });
      return { contents: js.code, loader: 'js' };
    });
  },
});
