# Known Issues

## Open

### 1. RBAC not implemented — role checking disabled
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

### Multipart SMS stored as separate messages — Fixed 2026-03-11
**Impact**: Long SMS messages (>160 chars) appeared as 2-3 separate messages in the UI.

**Solution**: Implemented PDU mode SMS parser with UDH (User Data Header) extraction to detect and assemble multipart messages.
- PDU parser extracts concatenation metadata (ref_id, total_parts, part_number)
- Messages grouped and assembled inline during read operation in `modem_manager.rs`
- Fallback to text mode if PDU parsing fails
- All parts deleted together from SIM storage
- Background cleanup task removes orphaned segments after 5 minutes

**Result**: Long messages now appear as single entries in UI, message counts are accurate.

**Commit**: a753b5c - feat(daemon): implement multipart SMS assembly

### ICCID trailing `F` padding — Fixed 2026-03-06
Daemon created duplicate SIM records (with/without BCD padding `F`). Fixed by stripping trailing `F` in all 3 ICCID entry points (`at_modem.rs`, `native_dbus.rs`, `dbus_client.rs`). Migration 014 cleaned 23 duplicates.

### Stale SIM assignments — Fixed 2026-03-06
Modems accumulated stale SIM associations on swap/disconnect. Fixed reconciliation filter (`control.js:47`) and added SIM eviction loop. Migration 016 cleaned existing stale data.
