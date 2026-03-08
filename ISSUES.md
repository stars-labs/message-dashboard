# Known Issues

## Open

### 1. Multipart SMS stored as separate messages
**Status**: Open
**Impact**: Long SMS messages (>160 chars) appear as 2-3 separate messages in the UI instead of one combined message

The GSM network splits long SMS into multiple segments (concatenated SMS / multipart SMS). The daemon's `list_sms_text_mode` in `at_modem.rs` stores each segment as a separate DB row because it doesn't parse the PDU concatenation headers (UDH — User Data Header) that indicate which segments belong together.

All segments share the same `phone_iccid`, `phone_number`, and `timestamp`, but have different `id` values and partial `content`.

**Fix approach**: Handle in the daemon — parse the UDH concatenation info from PDU mode (reference number, total parts, part number) and either:
1. Buffer segments in the daemon and only upload the combined message once all parts arrive
2. Include concatenation metadata (ref_id, part_number, total_parts) in the upload so the server can merge them

Option 1 is preferred as it keeps the server simple and avoids pagination count mismatches.

### 2. RBAC not implemented — role checking disabled
**Status**: Open (future)
**Impact**: Any Auth0-authenticated user gets full access. No role differentiation.

Currently `USE_AUTH0_ROLES = "false"` in `wrangler.toml`. The RBAC middleware and `sms` role infrastructure exist but are unused.

**When to implement**:
- When multiple users with different permission levels need access
- When external users (non-team) need restricted read-only access

**What exists already**:
- Auth0 role extraction from JWT tokens (`server/handlers/auth0.js:99-121`)
- RBAC middleware with granular permissions (`server/middleware/rbac.js`)
- Role config: `AUTH0_SMS_ROLE`, `AUTH0_ALTERNATIVE_SMS_ROLES`, `AUTH0_ROLE_NAMESPACE` in `wrangler.toml`
- Permission strings: `phones.read`, `phones.write`, `messages.read`, `messages.send`, `keywords.read`, `keywords.write`

**To implement**:
1. Define roles in Auth0 Dashboard (e.g. `admin`, `viewer`, `operator`)
2. Create Auth0 Action to add roles to token claims under `https://sexy.qzz.io/roles`
3. Map roles to permission sets in `server/middleware/rbac.js`
4. Set `USE_AUTH0_ROLES = "true"` in `wrangler.toml`
5. Test with accounts that have different roles assigned

---

## Resolved

### ICCID trailing `F` padding — Fixed 2026-03-06
Daemon created duplicate SIM records (with/without BCD padding `F`). Fixed by stripping trailing `F` in all 3 ICCID entry points (`at_modem.rs`, `native_dbus.rs`, `dbus_client.rs`). Migration 014 cleaned 23 duplicates.

### Stale SIM assignments — Fixed 2026-03-06
Modems accumulated stale SIM associations on swap/disconnect. Fixed reconciliation filter (`control.js:47`) and added SIM eviction loop. Migration 016 cleaned existing stale data.
