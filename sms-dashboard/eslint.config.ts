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
import ts from 'typescript';
import { relative } from 'node:path';
import { fileURLToPath } from 'node:url';

// The server files that have joined the strict gate, read from the Worker
// project so the two cannot disagree.
function joinedServerFiles(): string[] {
  const project = ts.getParsedCommandLineOfConfigFile(
    fileURLToPath(new URL('tsconfig.worker.json', import.meta.url)),
    {},
    {
      ...ts.sys,
      onUnRecoverableConfigFileDiagnostic: (diagnostic) => {
        throw new Error(ts.flattenDiagnosticMessageText(diagnostic.messageText, '\n'));
      },
    },
  );
  if (!project) throw new Error('tsconfig.worker.json could not be read');
  return project.fileNames
    .map((file) => relative(import.meta.dirname, file))
    .filter((file) => file.startsWith('server/'));
}

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
    // In server/, the files in tsconfig.worker.json and the TypeScript tests have joined.
    'server/**/*.js',
    'server/**/*.ts',
    ...joinedServerFiles().map((file) => `!${file}`),
    '!server/**/*.test.ts',
    'client/',
    'test/*.js',
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
    'worker-runtime.d.ts',
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
    extends: [tseslint.configs.strictTypeChecked, tseslint.configs.stylisticTypeChecked],
    languageOptions: {
      parserOptions: { projectService: true, tsconfigRootDir: import.meta.dirname },
    },
    rules: {
      // A number has one string form; anything else is converted explicitly.
      '@typescript-eslint/restrict-template-expressions': ['error', { allowNumber: true }],
      '@typescript-eslint/no-unused-vars': unusedVars,
      // `as const` stays legal; no `as`, no `<T>x`, no `!` non-null assertion.
      '@typescript-eslint/consistent-type-assertions': ['error', { assertionStyle: 'never' }],
      '@typescript-eslint/no-shadow': 'error',
      'preserve-caught-error': 'error',
      // A switch over a union names every member; a `default` cannot hide a new one.
      '@typescript-eslint/switch-exhaustiveness-check': [
        'error',
        { considerDefaultExhaustiveForUnions: false, requireDefaultForNonUnion: true },
      ],
    },
  },
  {
    name: 'Untyped data enters through a schema',
    files: ['**/*.ts'],
    ignores: ['shared/parse-json.ts', 'server/lib/d1.ts', '**/*.test.ts'],
    rules: {
      'no-restricted-syntax': [
        'error',
        {
          selector:
            "CallExpression[callee.type='MemberExpression'][callee.property.name=/^(first|all|raw|get|json)$/][typeArguments]",
          message:
            'A type argument here is an unchecked cast. Parse the value with a schema: readJson / parseJson (shared/parse-json.ts) or queryAll / queryFirst (server/lib/d1.ts).',
        },
        {
          selector:
            "CallExpression[callee.type='MemberExpression'][callee.property.name='json'][arguments.length=0]",
          message: 'Read JSON bodies with readJson(body, schema) from shared/parse-json.ts.',
        },
        {
          selector: "CallExpression[callee.object.name='JSON'][callee.property.name='parse']",
          message: 'Parse JSON text with parseJson(text, schema) from shared/parse-json.ts.',
        },
        {
          selector:
            "CallExpression[callee.type='MemberExpression'][callee.property.name=/^(all|first|raw)$/][arguments.length=0]",
          message: 'Read D1 rows with queryAll / queryFirst from server/lib/d1.ts.',
        },
      ],
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
