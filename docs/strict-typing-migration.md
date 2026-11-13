# Strict typing migration — execution brief

Branch: `chore/quality-audit` (continue it; do not rebase away existing commits).
Reference implementation: `~/code/github/family-tree` (`tsconfig.base.json`,
`tsconfig.json` references, `eslint.config.ts`). Read those files before Phase 0.

Decisions are final. A change to any rule, flag, or tool below needs approval
from the reviewing session first — ask, don't improvise.

## End state

**Dashboard (`sms-dashboard/`)**

- Zero tracked `.js` / `.mjs` / `.cjs` files except generated output
  (`server/frontend-assets.js`). Configs (`vite`, `svelte`, `tailwind`,
  `postcss`), tests, `runner-core/`, `balance-agent/`, `scripts/`, `test/setup`
  are all TypeScript. Every `.svelte` file uses `<script lang="ts">`.
- `tsconfig.base.json` copied from family-tree (strict, `noUncheckedIndexedAccess`,
  `exactOptionalPropertyTypes`, `noPropertyAccessFromIndexSignature`,
  `noImplicitOverride`, `noImplicitReturns`, `useUnknownInCatchVariables`,
  `verbatimModuleSyntax`, `erasableSyntaxOnly`). No `allowJs`.
- `tsconfig.json` = `files: []` + project references, one per area, each with
  only the `lib`/`types` its runtime has:
  worker (`server/`, Workers types, **no DOM**), client (DOM), shared,
  runner-core, balance-agent main / preload / renderer, scripts + tooling,
  and a test project per area. Includes are globs, never entry files.
- `typecheck` = `tsc -b` + `svelte-check --fail-on-warnings`.
- Lint = ESLint flat config in TypeScript: `typescript-eslint` `strictTypeChecked`
  + `eslint-plugin-svelte` + `@eslint-community/eslint-comments` with
  `require-description`, `reportUnusedDisableDirectives: 'error'`,
  `reportUnusedInlineConfigs: 'error'`. Additionally:
  - `@typescript-eslint/consistent-type-assertions`: `{ assertionStyle: 'never' }`
    (`as const` stays legal). No `as`, no `<T>x`, no `!` non-null.
  - Test files may turn off only `no-unsafe-assignment`, `no-unsafe-member-access`,
    `no-unsafe-argument` (same as family-tree). Nothing else is relaxed anywhere.
- **oxlint is removed**: package, `.oxlintrc.json`, `lint` script, `flake.nix`
  devshell entry, CI step. Delete `docs/web-lint-audit.md` (superseded by this file).
  Timing: see "Gate migration" below.
- Formatting is Prettier's, with `prettier-plugin-svelte`. `eslint-config-prettier`
  is the last entry in the ESLint config so no lint rule fights the formatter.
  `.prettierrc` keeps this repo's existing style (semicolons, single quotes,
  `trailingComma: "all"`, `printWidth: 100`) to keep the format commit's churn
  down. The format commit touches formatting only, the whole dashboard at once
  (all areas, joined or not), and its hash goes into `.git-blame-ignore-revs`.
- `bun run check` runs format check → typecheck → lint → test → build; CI runs
  `bun run check`.

**Daemon (`orange-pi-daemon/`)**

- `Cargo.toml` `[lints]`:
  - `rust`: `unsafe_code = "forbid"`
  - `clippy`: `pedantic = { level = "warn", priority = -1 }`, and `warn` for
    `unwrap_used`, `expect_used`, `indexing_slicing`, `panic`, `as_conversions`
  - `allow`: `missing_errors_doc`, `missing_panics_doc`, `must_use_candidate`,
    `module_name_repetitions`
- `clippy.toml`: `allow-unwrap-in-tests`, `allow-expect-in-tests`,
  `allow-indexing-slicing-in-tests`, `allow-panic-in-tests` = true.
- The existing `-D warnings` gate turns all of the above into errors. No
  `#[allow]` without a `reason = "..."`; add `clippy::allow_attributes_without_reason = "warn"`.
- Stringly fields become enums (e.g. `Message.direction`, status/state/kind
  fields). `serde_json::Value` / `json!` disappear from non-test code.
- Newtypes with validating constructors (`TryFrom<&str>`), `#[serde(try_from = "String")]`:
  `Iccid`, `Imei`, `Imsi`, `PhoneNumber`, and the modem port/SIM index. Raw
  `String`/integers for these never cross a function boundary.

**Daemon ↔ Worker contract (single source of truth = Rust)**

- A `wire` module in the daemon holds every request and response body that
  crosses the daemon↔Worker boundary (`api_client.rs` uploads, health snapshot,
  call events, pending-SMS / control responses, `UploadResult`).
- `#[derive(TS)]` (ts-rs) exports them to `sms-dashboard/shared/daemon-wire/`,
  checked in. Newtypes export as branded types
  (`string & { readonly __brand: 'Iccid' }`).
- Gate: regenerate, then `git diff --exit-code sms-dashboard/shared/daemon-wire`.
  Prove the gate fails by hand-editing one generated file once.
- Worker parses those bodies with valibot schemas annotated
  `v.GenericSchema<unknown, WireType>` so the compiler checks schema ↔ Rust type.
  The Worker never re-declares a wire type by hand.

## Boundary rule (valibot)

Every value from outside the process is `unknown` until a valibot schema parses
it: request bodies, query/params, D1 rows, KV values, `fetch` responses
(Auth0, carrier sites, AI), `postMessage`/IPC, IndexedDB, `localStorage`.

- JSON text and upstream responses: `readJson(body, schema)` / `parseJson(text, schema)`
  from `shared/parse-json.ts`. They return `{ ok, value } | { ok: false, error }`;
  the handler answers the bad input itself.
- Request bodies: `readBody(request, Schema, MISSING_KEY_MESSAGES)` from
  `server/lib/request-body.ts`. The schema declares every 400 message; the
  missing-key table is typed to list exactly the required keys. A body that is
  not JSON answers `NOT_JSON_MESSAGE`; a JSON array is never an object body.
- D1: `queryAll` / `queryFirst` from `server/lib/d1.ts`. No `.first<T>()` /
  `.all<T>()` type arguments. ESLint enforces both rules.
- Row schemas live next to the query that produces them and list exactly the
  selected columns (no `SELECT *` into a schema). A column is non-null in the
  schema only if the table declares it `NOT NULL` / primary key, or the view
  expression cannot yield null.
- Verify every row schema by running its real SQL against a local snapshot of
  production D1 (`.wrangler/state/v3/d1`) and parsing every row; then break one
  field and confirm the harness reports the failure.

## Dependencies and tests

- A handler or utility declares only what it uses, structurally, through the
  ports in `server/lib/`: `D1<'all' | 'first' | 'run'>`, `D1Batch<Op>` (d1.ts),
  `KV<'get' | 'put' | 'delete'>` + `readKvJson` (kv.ts). Not `AppRequest` / `Env`.
  The router's call site then checks that the real request provides it.
- Tests pass plain objects that implement exactly those members. No `as`, no
  `eslint-disable`, no "test double" helper that casts.
- Code whose behaviour is SQL is tested against real SQLite through
  `test/sqlite-d1.ts`, not against canned rows, on tables built by running the
  real migration files (`test/sims-schema.ts`, `test/runner-schema.ts`,
  `test/balance-schema.ts`). Pin the old behaviour first: the test passes before
  the refactor and after it.
- Server tests run on native Bun; only `client/` tests load happy-dom
  (`bunfig.client.toml`). Build requests as real `Request` objects.
- A value read from settings or config with a closed set of values (e.g. the AI
  protocol) is a valibot `picklist`; code takes the union and switches over it
  exhaustively. Never widen a union to `string` to keep a branch testable.
- Lint is `strictTypeChecked` + `stylisticTypeChecked` +
  `switch-exhaustiveness-check`. `||` → `??` only where the left side cannot be
  `''`/`0`/`false` by meaning; otherwise make the intent explicit and test it.
- Controls (break code to prove a check fails) are made with the Edit tool and
  reverted with it, like any other edit.
- Every re-typed file gets a TypeScript test (`*.test.ts`) covering its
  behaviour, including the schema-mismatch path. A file with no tests gets them
  in the same commit.
- Dead code found on the way (unrouted handlers, unused exports) is deleted in
  its own `refactor` commit, with the search that proves it unused in the message.
- Branded `Iccid` etc. in TS come only from schemas, never from a cast.
- Errors: `catch (error)` stays `unknown`; read it via one shared helper, not
  `(error as Error)`.
- Index-signature types (`[k: string]: unknown`) are removed; model the real shape.
- Cloudflare types come from `wrangler types`, checked in as two files:
  `worker-runtime.d.ts` (runtime globals) and `worker-configuration.d.ts` (`Env`).
  The drift gate regenerates both and fails on any diff (`wrangler types --check`
  does not detect edits). Server files join `tsconfig.worker.json` one at a time
  with the runtime file; `worker-configuration.d.ts` joins with the last file,
  because its Durable Object type imports `server/index.ts`. That commit deletes
  `server/cf-bindings.ts` and the hand-written `Env`.

## Order

Stop after each phase and report the commit range to the reviewing session.
Do not start the next phase until it is approved.

### Gate migration

The strict flags cannot land on existing code in one green commit, so areas join
the strict gate one at a time:

- **Strict gate**: `tsconfig.json` references + ESLint `files`. It lists only
  areas that have joined. ESLint never sees a `.js` file.
- **Legacy gate**: the pre-migration tsconfig renamed to `tsconfig.legacy.json`,
  plus oxlint, both scoped to the areas that have not joined yet. No area is ever
  unchecked.
- An area moves from legacy to strict in the same commit that makes it clean
  under the strict config. The commit that moves the last area deletes
  `tsconfig.legacy.json`, oxlint (package, config, flake entry) and
  `docs/web-lint-audit.md`.
- `bun run check` runs both gates while both exist; every commit passes it.

Worker-only declarations live in `server/`, not `shared/`: `worker-context.ts`
and `secrets-env.d.ts`. Secrets set with `wrangler secret put` are declared once,
in `server/secrets-env.d.ts`, as optional properties merged into the generated
`Env`. `shared/` never includes `worker-configuration.d.ts` (its Durable Object
types import `server/`).

0. **Foundation.** base tsconfig + references, `wrangler types` with drift gate
   (`wrangler types --check`), ESLint config, `check` script, CI, legacy gate.
   Joins: shared + config, made clean.
0a. **Close the legacy gap**: legacy includes become globs (`server/**/*.ts`,
   `client/**/*.ts`) so no TS file is orphaned; fix what that exposes.
0b. **Prettier**: config + `eslint-config-prettier` commit, then the format-only
   commit, then `.git-blame-ignore-revs`.
1. **Re-type existing TS under the strict config**, one area per commit series:
   server → client/lib. Each series ends with that area joining. Valibot
   boundaries land here.
2. **Remaining server JS + all server tests** to TS.
3. **Client:** Svelte `lang="ts"`, `svelte-check`, client tests.
4. **runner-core, balance-agent, scripts, configs, test setup.** The last area
   joining removes the legacy gate; add a gate that fails on any tracked
   non-generated JS file.
5. **Daemon lints** (D1): `[lints]` + `clippy.toml`, fix findings. `indexing_slicing`
   and `unwrap_used` in AT parsing get real error paths, not `.get().unwrap()`.
6. **Daemon types** (D2): enums, newtypes.
7. **Wire contract** (D3): `wire` module, ts-rs export, Worker consumes it, drift gate.

Phases 5–7 touch no dashboard files except `shared/daemon-wire/` and its consumers.

## Hard rules

- Atomic commits: each builds and passes `bun run check` (dashboard) /
  `nix develop .#rust -c check-daemon` (daemon). Test-first for any behaviour fix the typing
  exposes, committed separately as `fix(...)`.
- Typing must not change behaviour. If it must, that is a separate `fix` commit
  with a test that failed before.
- Never weaken a test, skip a test, or loosen a rule to get green. Never
  `--no-verify`.
- No comments by default; delete JSDoc type annotations from `.ts` files.
- No shims or compatibility re-exports: when a file moves to `.ts`, the `.js` is
  gone in the same commit and every importer is updated.
- Respect the repo hard boundaries (secrets, production, CAPTCHA).
- Bun only; tooling from the flake.
