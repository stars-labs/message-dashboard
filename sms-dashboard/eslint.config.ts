import js from '@eslint/js';
import comments from '@eslint-community/eslint-plugin-eslint-comments/configs';
import { defineConfig, globalIgnores } from 'eslint/config';
import { includeIgnoreFile } from '@eslint/config-helpers';
import prettier from 'eslint-config-prettier';
import svelte from 'eslint-plugin-svelte';
import tseslint from 'typescript-eslint';
import { fileURLToPath } from 'node:url';

const unusedVars: [
  'error',
  { argsIgnorePattern: string; caughtErrorsIgnorePattern: string; ignoreRestSiblings: boolean },
] = [
  'error',
  { argsIgnorePattern: '^_', caughtErrorsIgnorePattern: '^_', ignoreRestSiblings: true },
];

// A later block that sets a rule replaces the options of an earlier one, so each block
// lists every selector or import its files are held to.

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
function touching(tables: string) {
  const sql = `/\\b(from|join|into|update)\\s+(${tables})\\b/i`;
  return [
    { selector: `TemplateElement[value.raw=${sql}]`, message: DEVICE_TABLE_MESSAGE },
    { selector: `Literal[value=${sql}]`, message: DEVICE_TABLE_MESSAGE },
  ];
}

const DEVICE_TABLES = touching('sims|modems');

const SCHEMA_CHANGE_MESSAGE =
  'Change the schema in a new migration (migrations/NNN_name.sql), never at runtime.';
const SCHEMA_CHANGE_SQL = '/\\b(create|drop|alter)\\s+(unique\\s+)?(table|index|view|trigger)\\b/i';

const SCHEMA_CHANGES = [
  { selector: `TemplateElement[value.raw=${SCHEMA_CHANGE_SQL}]`, message: SCHEMA_CHANGE_MESSAGE },
  { selector: `Literal[value=${SCHEMA_CHANGE_SQL}]`, message: SCHEMA_CHANGE_MESSAGE },
];

const TEST_SCHEMA_MESSAGE =
  "Build the database with createSchema (test/schema.ts), production's baseline, not a hand-written table.";
const TEST_SCHEMA_SQL = '/\\bcreate\\s+(unique\\s+)?(table|index|view|trigger)\\b/i';

const TEST_SCHEMAS = [
  { selector: `TemplateElement[value.raw=${TEST_SCHEMA_SQL}]`, message: TEST_SCHEMA_MESSAGE },
  { selector: `Literal[value=${TEST_SCHEMA_SQL}]`, message: TEST_SCHEMA_MESSAGE },
];

const BASELINE_READ_MESSAGE =
  "A migration's test builds the tables as they were before it. The baseline (schema.sql, reference-data.sql) moves past the migration once it reaches production, and the test then fails.";
const BASELINE_FILE = '/(^|\\/)(schema|reference-data)\\.sql$/';

const BASELINE_READS = [
  { selector: `TemplateElement[value.raw=${BASELINE_FILE}]`, message: BASELINE_READ_MESSAGE },
  { selector: `Literal[value=${BASELINE_FILE}]`, message: BASELINE_READ_MESSAGE },
];

const ORPC_OC = {
  name: '@orpc/contract',
  importNames: ['oc'],
  message:
    'Declare a contract route with route(access, method, path) from shared/api/contract/route.ts.',
};

export default defineConfig([
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
    name: 'A source file stays small enough to read whole',
    files: ['**/*.ts', '**/*.svelte'],
    ignores: ['**/*.test.ts'],
    rules: { 'max-lines': ['error', { max: 600, skipBlankLines: true, skipComments: true }] },
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
    ignores: ['server/lib/d1.ts', 'server/db/**', '**/*.test.ts'],
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
    ignores: ['**/*.test.ts', 'server/db/sims.ts', 'server/db/modems.ts'],
    rules: {
      'no-restricted-syntax': ['error', ...UNTYPED_DATA, ...DEVICE_TABLES, ...SCHEMA_CHANGES],
    },
  },
  {
    name: 'server/db/sims.ts owns sims, not modems',
    files: ['server/db/sims.ts'],
    rules: {
      'no-restricted-syntax': ['error', ...UNTYPED_DATA, ...touching('modems'), ...SCHEMA_CHANGES],
    },
  },
  {
    name: 'server/db/modems.ts owns modems, not sims',
    files: ['server/db/modems.ts'],
    rules: {
      'no-restricted-syntax': ['error', ...UNTYPED_DATA, ...touching('sims'), ...SCHEMA_CHANGES],
    },
  },
  {
    name: "Tests run on production's schema",
    files: ['**/*.test.ts'],
    ignores: [
      // A migration's test starts from the tables as they were before it.
      'migrations/**',
      // These test the SQL tooling itself, on toy tables.
      'scripts/schema-drift.test.ts',
      'test/sqlite-d1.test.ts',
    ],
    rules: { 'no-restricted-syntax': ['error', ...TEST_SCHEMAS] },
  },
  {
    name: "A migration's test does not start from the baseline",
    files: ['migrations/**/*.test.ts'],
    ignores: ['migrations/baseline.test.ts'],
    rules: { 'no-restricted-syntax': ['error', ...BASELINE_READS] },
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
  // After the TypeScript block, so the Svelte parser owns .svelte files.
  svelte.configs.recommended,
  {
    name: 'Svelte components: scripts parsed as TypeScript',
    files: ['**/*.svelte', '**/*.svelte.ts'],
    languageOptions: { parserOptions: { parser: tseslint.parser } },
    rules: { 'no-undef': 'off' },
  },
  // Last: switches off the rules Prettier owns.
  prettier,
  svelte.configs.prettier,
]);
