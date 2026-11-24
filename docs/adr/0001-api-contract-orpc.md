# ADR 0001: Serve the API through an oRPC contract

- Status: accepted (GRA-62, pilot for GRA-40)
- Date: 2026-11-15
- Pilot commit: `d266b2e`, on top of the safety nets in `64b701b`, `2748602`, `10c3280`
- Outcome: every `/api/*` route moved to the contract (GRA-63, GRA-64). The legacy
  Router now serves only the OAuth redirects, CORS preflight and the app shell, and
  the follow-ups listed under Consequences shipped: `openapi.json` generation,
  `check-api-compat` in CI, a problem 404 for unknown `/api/*` paths, and
  runner-token access. The 1.16.2 pin stands. The rest of this record describes
  the pilot as it was.

## Context

A route's path, method, parameters, access and answer live in four unconnected
places: the Router registration, the handler, the client's hand-built URL, and
for `/api/control/*` the daemon and Balance Agent. GRA-40 chose oRPC 1.16.2,
contract first, with Valibot schemas and RFC 9457 errors. Before migrating every
route, the pilot moved three and answered four questions the documentation
did not settle:

- `GET /api/users`
- `PUT /api/users/:id/role`
- `POST /api/control/heartbeat`

## Decision

Continue. Each question has an answer that needs no patch or fork of oRPC.
Both sizes are inside the limits set before the pilot: Worker gzip at most
+100 KB, frontend gzip at most +15 KB.

The pilot code stays, in the layout GRA-63 (01.5) builds on:

| Path | Holds |
|---|---|
| `shared/api/contract/` | the contract; `route(access, method, path)` is the only way to declare a route |
| `server/contract/` | the entry, the procedures and the error encoders |
| `client/lib/contract-client.ts` | the typed client |

## The four questions

### 1. Errors: RFC 9457, and an Auth0 429 as a 503 with Retry-After

Yes. The users routes answer `application/problem+json` with `type`
(`about:blank`), `title` (the status phrase), `status`, `detail` and `code`.

An Auth0 429 becomes a 503 carrying Auth0's `Retry-After`; it used to be a
bare 502.

Evidence: `server/contract/handler.test.ts`, and `server/handlers/users.test.ts`
("surfaces a rate-limited Management API as a retryable 503…").

What the installed source says, and the online docs (written for 2.0) do not:

- The option is `customErrorResponseBodyEncoder`. There is no
  `errorResponseContentType`. The fetch adapter always sets
  `Content-Type: application/json` and drops any other value
  (`@orpc/standard-server-fetch` `toFetchBody`).
  - The entry restates it: `application/json;charset=utf-8`, as the Router
    answers, for success; `application/problem+json` for errors
    (`withMediaType`).
- `encodeError` always returns empty headers. `ResponseHeadersPlugin` merges
  `context.resHeaders` into every matched response, errors included, so a
  procedure sets `Retry-After` before it throws.

Auth0's rate-limit documentation does not name the headers on a 429. A
community answer shows `retry-after`. The Worker passes `Retry-After` on when
Auth0 sends it and adds none otherwise. Not verified against a live 429.

### 2. Fallback to the legacy Router

Yes. `handleContract` answers when the request names a contract route and
returns null otherwise, so `router.handle` takes it.

`routeTable()` lists contract routes ahead of the Router's. The route census,
the route-auth test and the client URL test therefore still see all 87 routes
(`server/route-census.test.ts`, `server/route-auth.test.ts`).

Found on the way: oRPC decodes the body before any middleware runs
(`decode_input` in `@orpc/server` `StandardHandler.handle`). Left alone, an
anonymous request with a broken body would get a 400 and not a 401, and the
body would be parsed before the caller is known.

The entry therefore matches the request with oRPC's own
`StandardOpenAPIMatcher`, enforces the access the contract declares, and only
then hands the request to oRPC. The test is "check access before reading the
body" in `server/contract/handler.test.ts`.

### 3. The heartbeat on the wire

Byte for byte. `64b701b` made the fixture replay compare status, Content-Type
and the exact body text, and recorded the heartbeat refusals: no key, a body
that is not JSON, and an unsupported schema version.

All four heartbeat fixtures pass through oRPC unchanged. The daemon's gate
(`check-daemon`) passes too.

The body that is not JSON needed one mapping. oRPC reports it as its own
BAD_REQUEST, and `daemonErrorOf` turns that back into `Body must be JSON`.

### 4. Size

Measured with `bun run build:unified` and `wrangler deploy --dry-run`:

| | Before | After | Change |
|---|---|---|---|
| Worker, gzip | 270.29 KiB | 304.67 KiB | +34.4 KiB |
| Frontend `index-*.js`, gzip | 117,477 B | 128,072 B | +10.3 KiB |

The Worker bundle embeds the frontend, so its change includes the frontend's.

## Workarounds this decision accepts

All of them apply to the whole entry, none to a single route:

- The entry rewrites `Content-Type` after oRPC answers.
- The entry matches a request twice: once itself to enforce access, once
  inside oRPC. Both use oRPC's matcher class, so they cannot disagree.
- `daemonErrorOf` recognises a body that failed to parse by its `SyntaxError`
  cause.
- `tsconfig.base.json` states `moduleResolution: bundler` (`10c3280`). Before,
  svelte-check fell back to Node10, which ignores package `exports`, the only
  place oRPC publishes its types.

## Consequences

- oRPC 2.0 is in beta (`2.0.0-beta.50`) and renames options this code uses.
  Stay pinned to 1.16.2; upgrading is its own card.
- The heartbeat contract takes `v.unknown()`, so `normalizeHealthSnapshot`
  keeps answering daemons a version ahead or behind exactly as before. Typing
  it is for the module migration, against the fixtures.
- Not covered by the pilot, left to GRA-63 and GRA-64:
  - generating the OpenAPI document
  - checking breaking changes in CI
  - a problem 404 for unknown `/api/*` paths
  - runner-token access
