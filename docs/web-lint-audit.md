# Web lint audit — 2026-11-12

Scope: `sms-dashboard/` (Worker `server/`, Svelte 5 `client/`, `shared/`,
`runner-core/`, `balance-agent/src/`, `scripts/`, `config/`, `migrations/`,
`test/`). Rust daemon is out of scope (covered separately).

## Current state

| Check | Status |
|---|---|
| JS/TS lint | **none** — no config, no `lint` script, no CI step |
| Svelte markup lint | none (Svelte compiler warnings only, via `vite build`) |
| Formatter | **none** — no prettier/biome/oxfmt/dprint |
| Type checking | **none** — no `tsconfig.json`, no `checkJs`, `vite-env.d.ts` is the only `.d.ts` |
| `oxlint` | **installed in the dev shell** (`flake.nix` default + `daemon` shells), **invoked nowhere** |

So the only gate today is `bun run test` + `bun run build`. Lint-level defects
(unused vars, dead expressions, lost error causes) pass CI.

## Measured baseline (oxlint 1.86.0, dev shell)

Command: `oxlint <all source dirs>` — default config (correctness category).

| Result | Count |
|---|---|
| problems | **27** |
| `eslint(no-unused-vars)` | 20 |
| `eslint(no-unused-expressions)` | 5 — all intentional, see below |
| `eslint(no-useless-escape)` | 1 |
| `unicorn(no-useless-fallback-in-spread)` | 1 (`IccidMappingDialog.svelte:94`) |
| **`.svelte` files linted** | ✅ — script blocks are parsed (proof: 6 findings above) |

Conclusion: the codebase is already near-clean at default settings. Enabling the
gate is cheap; **no code rewrite needed**.

### What each category adds (measured, not guessed)

`-D suspicious` → 146 findings. Not adoptable wholesale:

| Rule | Count | Verdict |
|---|---|---|
| `unicorn(no-array-sort)` | 33 | Noisy — `.toSorted()` is ES2023; flag only if target allows |
| `oxc(no-async-endpoint-handlers)` | 23 | **False positives** for Cloudflare Workers (`async fetch(request, env, ctx)` is correct) |
| `eslint(no-underscore-dangle)` | 18 | Style — `_` prefix is a deliberate convention here |
| `unicorn(consistent-function-scoping)` | 16 | Style |
| `eslint(no-shadow)` | 15 | **Real** — worth enabling |
| `unicorn(prefer-add-event-listener)` | 7 | Style |
| `eslint(no-unmodified-loop-condition)` | 2 | **False positive verified** — `serial-runner.js:33` loop tests `signal?.aborted`, mutated externally |
| `eslint(preserve-caught-error)` | 3 | **Real** — `run-lock.js:32,41`, `carrier-browser-workflow.js:502` drop the cause chain |

`-D perf` → 126 findings. Mostly ignore:

- `eslint(no-await-in-loop)` × 89 → **by design** in `runner-core/serial-runner.js`
  and `balance-queries.js` (serial execution is the contract; `Promise.all` would
  send concurrent AT commands / carrier requests).
- `oxc(no-map-spread)` × 8 → micro-perf on tiny arrays; ignore.
- `unicorn(prefer-set-has)` × 1 (`scripts/backup-database.js:26`) → real, trivial.
- `unicorn(prefer-array-find)` × 1 → trivial.

## Recommendation: adopt oxlint (not ESLint) as the web lint gate

### Why oxlint over ESLint here

1. **Already installed.** `flake.nix` ships `oxlint` in the default dev shell;
   ESLint would add a `typescript` + `eslint` + `eslint-plugin-svelte` +
   parser chain to `node_modules`, which conflicts with the repo's Nix-first,
   minimal-dependency preference.
2. **It lints `.svelte` script blocks** — confirmed on this repo, not assumed.
3. **Native speed** — the whole `sms-dashboard/` tree runs in well under a second.
4. **The real gap is small.** What ESLint + `eslint-plugin-svelte` adds that
   oxlint 1.86 does not is Svelte-*markup-aware* rules (`require-each-key`,
   `no-unused-svelte-ignore`, rune misuse) and the Svelte a11y set. Those are a
   meaningful complement, **not a replacement** — revisit only if a real defect
   slips through that the compiler misses. Do not adopt both on day one.

### Config

`sms-dashboard/.oxlintrc.json`:

```json
{
  "$schema": "./node_modules/oxlint/configuration_schema.json",
  "plugins": ["eslint", "typescript", "unicorn", "oxc", "import", "promise", "node"],
  "categories": {
    "correctness": "error",
    "suspicious": "off",
    "perf": "off",
    "style": "off",
    "pedantic": "off",
    "nursery": "off"
  },
  "rules": {
    "eslint/no-shadow": "error",
    "eslint/preserve-caught-error": "error",
    "eslint/no-unused-vars": ["warn", { "argsIgnorePattern": "^_", "caughtErrors": "none" }],
    "oxc/no-async-endpoint-handlers": "off",
    "eslint/no-unmodified-loop-condition": "off"
  },
  "overrides": [
    {
      "files": ["client/**/*.svelte"],
      "rules": {
        "eslint/no-unused-expressions": "off"
      }
    }
  ],
  "ignorePatterns": [
    "dist/**",
    "balance-agent/dist/**",
    "balance-agent/release/**",
    "node_modules/**"
  ]
}
```

Notes on the choices:

- `no-unused-vars` as **warn** so the 20 existing hits don't block the first
  commit; flip to `error` after the one-time cleanup.
- `caughtErrors: "none"` because `catch (error) { /* intentionally ignored */ }`
  appears 2× (`auth0.js:83`, `phones.js:116`). Prefer `catch { }` syntax.
- `preserve-caught-error` as **error** — it catches a real observability bug
  class (losing the stack when rethrowing).
- `no-shadow` as **error** — 15 hits; each needs a quick review, not a blind fix.

### Gate

`sms-dashboard/package.json`:

```json
"lint": "oxlint ."
```

`.github/workflows/ci.yml` — add to the `dashboard` job, **before** the test
step (lint fails fast, tests are the slow part):

```yaml
      - uses: cachix/install-nix-action@v31   # if oxlint comes from Nix, not npm
      - run: bun run lint
```

**Decision needed:** `oxlint` is currently Nix-only. In CI, either
(a) add `cachix/install-nix-action` + `nix develop -c oxlint` — consistent with
the daemon job but slow; or (b) add `oxlint` as a pinned `devDependency` so
`bun run lint` works in both local and CI. **(b) is the smaller change and keeps
the local-vs-CI binary identical.** Keep the flake's `oxlint` too — one version
pin per side would duplicate the answer. *If both are kept, remove one;*
single source of truth wins.

### Style/format — defer, do not adopt yet

No formatter today. Adding prettier/biome would produce one enormous whitespace
diff over ~250 files and obscure `git blame` for a year, for zero correctness
gain. The codebase is already consistent (2-space, single quotes, semicolons,
~100 col). **Recommendation: skip a formatter.** If one is ever wanted, use
`oxfmt` (same project, same config, no new dependency family) — not prettier.

## Phased plan

### Phase 1 — turn the gate on (one small commit)
1. Add `.oxlintrc.json` with the config above.
2. Add `"lint": "oxlint ."` to `package.json`; pin `oxlint` in `devDependencies`
   **or** add a `lint-web` shell app to `flake.nix` (pick one, not both).
3. Add the CI step in the `dashboard` job.
4. Fix the 27 existing findings in a **single** `chore(lint): ...` commit:
   - 20 `no-unused-vars` → delete or `_`-prefix.
   - 5 `no-unused-expressions` in `IccidMappings.svelte:224-227` → **not bugs.**
     They are bare statements inside `$effect` that force Svelte 5 to register
     the reads as dependencies (`filterMappings()` reads them inside a helper,
     which the dependency tracker does not see). Suppress with a per-file
     `// eslint-disable-next-line` comment **or** an `overrides` entry for
     `client/**/*.svelte`; add a comment explaining the idiom so the next reader
     does not "clean it up".
   - 1 `no-useless-escape`, 1 `no-useless-fallback-in-spread` → mechanical.
5. Flip `no-unused-vars` to `error`.

Acceptance: `bun run lint` exits 0; CI `dashboard` job runs it.

### Phase 2 — extend only what proves useful
After a few weeks of Phase 1:
- Enable `no-shadow` and `preserve-caught-error` fixes (already in config as
  errors — split into their own commit if the diff is noisy).
- Consider `unicorn(prefer-set-has)` / `prefer-array-find` case-by-case.
- **Do not** enable `suspicious` or `perf` as categories. Cherry-pick rules.

### Phase 3 — the actual quality lever (see the type-constraint audit)
`oxlint` finds unused variables. It will not find
`sim.service_type` vs `serviceType` mismatches or a Worker handler returning the
wrong shape. That requires `tsc --noEmit` + `checkJs`. Phase 3 belongs there.

## Unresolved questions

1. CI: `oxlint` via Nix action, or pinned `devDependency`? (Recommendation:
   `devDependency`.)
2. Should `no-unused-vars` start as `error` and the cleanup ship in the same
   commit? (Recommendation: start `warn`, clean up, then flip.)
3. ~~Are the 5 `no-unused-expressions` real bugs?~~ Resolved: intentional
   dependency tracking, not dead code. Remaining question: suppress per-line or
   per-`svelte`-glob? (Recommendation: glob override with one explanatory
   comment in the config.)