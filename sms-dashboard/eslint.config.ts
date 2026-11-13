// Lint rules for the areas that have joined the strict gate. TypeScript files
// are linted with type information, so the rules see the same types tsc does.
// Run with `bun run lint`, which also runs oxlint over the areas that have not
// joined yet; `bun run check` includes both.
import js from '@eslint/js';
import comments from '@eslint-community/eslint-plugin-eslint-comments/configs';
import { defineConfig, globalIgnores } from 'eslint/config';
import { includeIgnoreFile } from '@eslint/config-helpers';
import prettier from 'eslint-config-prettier';
import tseslint from 'typescript-eslint';
import { fileURLToPath } from 'node:url';

// A leading underscore marks a parameter or caught error that is unused on
// purpose; `{ dropped, ...kept }` is the idiom for omitting a field.
const unusedVars: [
  'error',
  { argsIgnorePattern: string; caughtErrorsIgnorePattern: string; ignoreRestSiblings: boolean },
] = [
  'error',
  { argsIgnorePattern: '^_', caughtErrorsIgnorePattern: '^_', ignoreRestSiblings: true },
];

export default defineConfig([
  // Whatever git ignores is not source: local worktrees, caches, builds.
  includeIgnoreFile(fileURLToPath(new URL('.gitignore', import.meta.url))),
  globalIgnores([
    'docs/',
    'balance-agent/dist/',
    'balance-agent/release/',
    // Areas that have not joined the strict gate. oxlint covers them instead;
    // each Phase 1 series removes its own line here as that area joins.
    'server/',
    'client/',
    'test/',
    'scripts/',
    'runner-core/',
    'balance-agent/',
    'migrations/',
    // Config files that Phase 4 converts to TypeScript.
    'vite.config.js',
    'svelte.config.js',
    'tailwind.config.js',
    'postcss.config.js',
    'worker-configuration.d.ts',
  ]),
  {
    linterOptions: {
      reportUnusedDisableDirectives: 'error',
      reportUnusedInlineConfigs: 'error',
    },
  },
  js.configs.recommended,
  comments.recommended,
  {
    rules: {
      // A disabled rule must say why, as an audit exception must.
      '@eslint-community/eslint-comments/require-description': 'error',
      'no-unused-vars': unusedVars,
    },
  },
  {
    name: 'TypeScript, linted with type information',
    files: ['**/*.ts'],
    extends: [tseslint.configs.strictTypeChecked],
    languageOptions: {
      parserOptions: { projectService: true, tsconfigRootDir: import.meta.dirname },
    },
    rules: {
      // A number has one string form; anything else is converted explicitly.
      '@typescript-eslint/restrict-template-expressions': ['error', { allowNumber: true }],
      '@typescript-eslint/no-unused-vars': unusedVars,
      // `as const` stays legal; no `as`, no `<T>x`, no `!` non-null assertion.
      '@typescript-eslint/consistent-type-assertions': ['error', { assertionStyle: 'never' }],
    },
  },
  {
    name: 'shared: runs in the Worker and the browser, so assumes neither',
    files: ['shared/**/*.ts', 'config/**/*.ts'],
    languageOptions: { sourceType: 'module' },
  },
  // Last: switches off every rule Prettier owns, so the two never disagree.
  prettier,
]);
