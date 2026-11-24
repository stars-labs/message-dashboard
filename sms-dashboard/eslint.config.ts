// Lint rules for the whole dashboard and balance-agent. TypeScript files are
// linted with type information, so the rules see the same types tsc does.
// Run with `bun run lint`; `bun run check` includes it.
import js from '@eslint/js';
import comments from '@eslint-community/eslint-plugin-eslint-comments/configs';
import { defineConfig, globalIgnores } from 'eslint/config';
import { includeIgnoreFile } from '@eslint/config-helpers';
import prettier from 'eslint-config-prettier';
import svelte from 'eslint-plugin-svelte';
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

// A later block that sets a rule for a file replaces the options of an earlier
// one, so each block below lists every selector or import its files are held to.

const UNTYPED_DATA = [
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
];

const API_PATH_MESSAGE =
  'Call the Dashboard through the contract client (client/lib/api.ts contractApi, balance-agent control-client), not a hand-built /api/ URL.';

const API_PATHS = [
  { selector: 'Literal[value=/^(https?:\\/\\/[^\\/]*)?\\/api\\//]', message: API_PATH_MESSAGE },
  { selector: 'TemplateElement[value.raw=/^\\/api\\//]', message: API_PATH_MESSAGE },
];

const D1_ACCESS = [
  {
    selector:
      "CallExpression[callee.type='MemberExpression'][callee.property.name=/^(prepare|batch)$/]",
    message:
      'Reach D1 through a function in server/db/; only the data layer prepares or batches statements.',
  },
];

const DEVICE_TABLE_MESSAGE =
  'Read devices from device_view. Only server/db/sims.ts touches sims, and only server/db/modems.ts touches modems.';
const DEVICE_TABLE_SQL = '/\\b(from|join|into|update)\\s+(sims|modems)\\b/i';

const DEVICE_TABLES = [
  { selector: `TemplateElement[value.raw=${DEVICE_TABLE_SQL}]`, message: DEVICE_TABLE_MESSAGE },
  { selector: `Literal[value=${DEVICE_TABLE_SQL}]`, message: DEVICE_TABLE_MESSAGE },
];

const SCHEMA_CHANGE_MESSAGE =
  'Change the schema in a new migration (migrations/NNN_name.sql), never at runtime.';
const SCHEMA_CHANGE_SQL = '/\\b(create|drop|alter)\\s+(unique\\s+)?(table|index|view|trigger)\\b/i';

const SCHEMA_CHANGES = [
  { selector: `TemplateElement[value.raw=${SCHEMA_CHANGE_SQL}]`, message: SCHEMA_CHANGE_MESSAGE },
  { selector: `Literal[value=${SCHEMA_CHANGE_SQL}]`, message: SCHEMA_CHANGE_MESSAGE },
];

// Each moves its SQL into server/db/ and leaves this list; nothing joins it.
const NOT_YET_ON_THE_DATA_LAYER = [
  'server/handlers/balance-queries.ts',
  'server/handlers/balance-runners.ts',
  'server/handlers/balance-skill-runner.ts',
  'server/handlers/calls.ts',
  'server/handlers/carrier-billing-backfill.ts',
  'server/handlers/carrier-bills.ts',
  'server/handlers/carrier-web-balance.ts',
  'server/handlers/control.ts',
  'server/handlers/filters.ts',
  'server/handlers/health.ts',
  'server/handlers/iccid-mappings.ts',
  'server/handlers/keywords.ts',
  'server/handlers/messages.ts',
  'server/utils/audit-log.ts',
  'server/utils/carrier-billing-backfill.ts',
  'server/utils/carrier-billing.ts',
  'server/utils/filter-history.ts',
  'server/utils/keyword-history.ts',
  'server/utils/message-retention.ts',
  'server/utils/spam-backfill.ts',
  'server/utils/spam-filter.ts',
  'server/utils/verification-backfill.ts',
];

const DEVICE_TABLE_OWNERS = ['server/db/sims.ts', 'server/db/modems.ts'];

const ORPC_OC = {
  name: '@orpc/contract',
  importNames: ['oc'],
  message:
    'Declare a contract route with route(access, method, path) from shared/api/contract/route.ts.',
};

export default defineConfig([
  // Whatever git ignores is not source: local worktrees, caches, builds.
  includeIgnoreFile(fileURLToPath(new URL('.gitignore', import.meta.url))),
  globalIgnores([
    'docs/',
    'balance-agent/dist/',
    'balance-agent/release/',
    'worker-configuration.d.ts',
    'worker-runtime.d.ts',
    'shared/daemon-wire/',
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
    files: ['**/*.ts', '**/*.svelte'],
    extends: [tseslint.configs.strictTypeChecked, tseslint.configs.stylisticTypeChecked],
    languageOptions: {
      parserOptions: {
        projectService: true,
        tsconfigRootDir: import.meta.dirname,
        extraFileExtensions: ['.svelte'],
      },
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
    rules: { 'no-restricted-syntax': ['error', ...UNTYPED_DATA] },
  },
  {
    name: 'Only server/db reaches D1',
    files: ['server/**/*.ts'],
    ignores: ['server/lib/d1.ts', 'server/db/**', '**/*.test.ts', ...NOT_YET_ON_THE_DATA_LAYER],
    rules: {
      'no-restricted-syntax': [
        'error',
        ...UNTYPED_DATA,
        ...D1_ACCESS,
        ...DEVICE_TABLES,
        ...SCHEMA_CHANGES,
      ],
    },
  },
  {
    name: 'server/db reads devices from device_view',
    files: ['server/db/**/*.ts'],
    ignores: ['**/*.test.ts', ...DEVICE_TABLE_OWNERS],
    rules: {
      'no-restricted-syntax': ['error', ...UNTYPED_DATA, ...DEVICE_TABLES, ...SCHEMA_CHANGES],
    },
  },
  {
    name: 'The device tables owners, and the files not yet on the data layer',
    files: [...DEVICE_TABLE_OWNERS, ...NOT_YET_ON_THE_DATA_LAYER],
    rules: { 'no-restricted-syntax': ['error', ...UNTYPED_DATA, ...SCHEMA_CHANGES] },
  },
  {
    name: 'Clients reach the Dashboard through the contract client',
    files: ['client/**/*.ts', 'balance-agent/src/**/*.ts'],
    ignores: ['**/*.test.ts'],
    rules: { 'no-restricted-syntax': ['error', ...UNTYPED_DATA, ...API_PATHS] },
  },
  {
    name: 'Svelte components reach the Dashboard through the contract client',
    files: ['client/**/*.svelte'],
    rules: { 'no-restricted-syntax': ['error', ...API_PATHS] },
  },
  {
    name: 'A contract route says who may call it',
    files: ['**/*.ts', '**/*.svelte'],
    ignores: ['shared/api/contract/route.ts'],
    rules: { 'no-restricted-imports': ['error', { paths: [ORPC_OC] }] },
  },
  {
    name: 'Only the contract admits a caller',
    files: ['server/**/*.ts'],
    ignores: ['server/contract/handler.ts', 'server/middleware/authorize.ts', '**/*.test.ts'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          paths: [ORPC_OC],
          patterns: [
            {
              regex: '(^|/)(auth0|authorize|control|runner-auth)(\\.js)?$',
              importNames: ['handleAuth0', 'authorize', 'requireApiKey', 'authorizeRunnerControl'],
              message:
                "Declare the route's access on the contract (shared/api/contract/route.ts); server/contract/handler.ts admits the caller.",
            },
          ],
        },
      ],
    },
  },
  {
    name: 'Only the contract reads a query',
    files: ['server/**/*.ts'],
    // The OAuth redirects build and read Auth0's query, outside the contract.
    ignores: ['server/handlers/auth0.ts', '**/*.test.ts'],
    rules: {
      'no-restricted-properties': [
        'error',
        {
          property: 'searchParams',
          message: "Declare the query on the route's contract input; the handler gets it parsed.",
        },
      ],
      'no-restricted-globals': [
        'error',
        {
          name: 'URLSearchParams',
          message: "Declare the query on the route's contract input; the handler gets it parsed.",
        },
      ],
    },
  },
  {
    name: 'shared: runs in the Worker and the browser, so assumes neither',
    files: ['shared/**/*.ts', 'config/**/*.ts'],
    languageOptions: { sourceType: 'module' },
  },
  // After the TypeScript block, so the Svelte parser owns .svelte files and
  // hands their scripts to the TypeScript parser.
  svelte.configs.recommended,
  {
    name: 'Svelte components: scripts parsed as TypeScript',
    files: ['**/*.svelte', '**/*.svelte.ts'],
    languageOptions: { parserOptions: { parser: tseslint.parser } },
    // TypeScript resolves every name, as typescript-eslint has it do for .ts.
    rules: { 'no-undef': 'off' },
  },
  // Last: switches off every rule Prettier owns, so the two never disagree.
  prettier,
  svelte.configs.prettier,
]);
