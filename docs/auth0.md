# Auth0 Setup

What the Auth0 tenant must hold for the dashboard and the Balance Agent to work.
The code side (permissions per role, the claim it reads, the email gate) lives in
`sms-dashboard/config/auth0-roles.ts` and `sms-dashboard/server/handlers/auth0.ts`.

## Roles

Create exactly two roles, `sms-admin` and `sms-viewer` (`AUTH0_ADMIN_ROLE` and
`AUTH0_VIEWER_ROLE` in `wrangler.toml`). The permissions each grants are fixed in
`config/auth0-roles.ts`; any other role Auth0 reports, including the retired `sms`,
grants nothing. Adding a role means adding it there with an explicit permission
list.

- `sms-viewer`: read messages and bills, see the SIM list, send SMS.
- `sms-admin`: everything, including keyword, filter and SIM editing, balance
  queries and user administration.

A verified user on an allowed domain gets `sms-viewer` automatically on first
login. Roles are exclusive: a change from the dashboard's 用户管理 page assigns the
new one, removes the other, and revokes the user's live sessions. Nobody can change
their own role, so **assign `sms-admin` to yourself in the Auth0 dashboard before
the first deploy**; an empty admin set can only be fixed there.

## Login Action

Auth0 drops unnamespaced custom claims, so a Post-Login Action (**Actions → Flows →
Login**) must copy the roles into both tokens under the full claim URI
`AUTH0_ROLE_NAMESPACE` (`https://sexy.itoken.world/roles`):

```javascript
exports.onExecutePostLogin = async (event, api) => {
  const namespace = 'https://sexy.itoken.world/';
  const assignedRoles = event.authorization?.roles || [];

  if (assignedRoles.length > 0) {
    api.idToken.setCustomClaim(namespace + 'roles', assignedRoles);
    api.accessToken.setCustomClaim(namespace + 'roles', assignedRoles);
  }
};
```

Authorization fails closed: if the Action is not deployed and active, nobody gets in.

## Applications and APIs

- **Dashboard** (Regular Web Application): `AUTH0_CLIENT_ID`, `AUTH0_CLIENT_SECRET`.
  Its login requests `AUTH0_LOGIN_AUDIENCE`, never the runner API. Callback, logout
  and web-origin URLs list the production hostname. The authorization code flow
  uses S256 PKCE and authenticates the Worker with `client_secret_post`. Before
  rollout, verify login on the isolated development tenant and confirm that Auth0
  rejects an exchange with a missing or mismatched verifier.
- **Management API client** (Machine to Machine, authorized for the Auth0
  Management API): `AUTH0_M2M_CLIENT_ID`, `AUTH0_M2M_CLIENT_SECRET`. Grant exactly
  `read:users`, `read:roles` and `update:users`, never `delete:users`. The Worker
  uses it to list users and assign roles.
- **Balance Agent** (Native application, Device Code grant, refresh tokens): it
  requests `AUTH0_AUDIENCE` with the scopes `balance:runners:heartbeat`,
  `balance:skills:run` and `balance:browser:run`.

The secrets go in with `bunx wrangler secret put <NAME>`; `AUTH0_DOMAIN` is the
tenant domain.

## Email gate

Besides a role, a user needs `email_verified` and an address on a domain in
`ALLOWED_EMAIL_DOMAINS`. A connection that does not set `email_verified` cannot log
in. Each denial writes a `login_denied` row to `audit_logs` whose `reason` says
which gate fired.

## Locked out

There is no override flag and no redeploy is needed. In **User Management → Users →**
the user **→ Roles**, assign `sms-admin` or `sms-viewer`, then have them log in
again. If nobody can log in, check that the Login Action is deployed and active and
that its namespace matches `AUTH0_ROLE_NAMESPACE` exactly; then read `audit_logs`.
