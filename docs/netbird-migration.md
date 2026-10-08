# NetBird: lubancat → Orange Pi (2026-10-08)

The NetBird control plane for `netbird.starslab.qzz.io` moved from a docker
compose stack on lubancat (0.70.5) to NixOS services on the Orange Pi (0.80.0).
Configuration: `nixos-config/modules/netbird-server.nix`.

## What changed for users

Same domain. Login moved from casdoor to Auth0 on 2026-10-08 with a fresh
account; peers and setup keys from the casdoor era are gone (they were test
data) and must be re-registered. Devices reconnected on their own when DNS
moved.

## What is different underneath

| | lubancat | Orange Pi |
| --- | --- | --- |
| Services | docker: management, signal, relay, coturn, dashboard | NixOS modules: management, signal, relay, dashboard |
| Fallback path | coturn (TURN on 3478/udp, 49152–65535/udp) | NetBird relay over 443 (`rels://…/relay`) |
| STUN | coturn | relay's built-in STUN on 3478/udp |
| TLS | nginx with a certbot certificate | nginx with HTTP-01 (port 80 forwarded) |
| Port 443 | nginx alone | nginx stream SNI router: voice bridge ↔ NetBird |

The relay had never been configured on lubancat (`management.json` had no
`Relay` block), so clients had depended on coturn alone.

## Secrets

Root-only files in `/var/lib/netbird-secrets/` on the Pi, not in this repository:

- `datastore-key` — `DataStoreEncryptionKey`, carried over; the store cannot be
  read with a different key
- `auth0-m2m-secret` — client secret of the "NetBird Management" Auth0
  application (Management API access for user profiles and invites)
- `relay-auth-secret` — generated on the Pi, shared by management and relay

The migration copy of `management.json` and the original `store.db` are kept in
`/root/netbird-migration/` on the Pi. lubancat's `/opt/netbird` is untouched.

## Identity: Auth0

NetBird on the Pi authenticates against the starslab Auth0 tenant
(`starslab.jp.auth0.com`); casdoor is no longer involved. Switched on
2026-10-08, together with a fresh store: the casdoor-era account held only
test data (one offline Oracle peer, expired setup keys), so it was backed up
to `/root/netbird-migration/pre-auth0/` and dropped.

Single-account mode is off: anyone with a Google account can pass Auth0, and
in that mode every such login would have joined the one network. Each new
identity now lands in its own empty account, and colleagues join ours only
through an invite sent from the dashboard (the management service creates
the Auth0 user through the M2M application). Self-service signup on the
username/password connection is disabled for the same reason.

Auth0 objects, created with the auth0 CLI (`nix shell nixpkgs#auth0-cli`):

| Object | Type | Notes |
|---|---|---|
| NetBird API | API | identifier `https://netbird.starslab.qzz.io/api`, scope `api`, offline access |
| NetBird Dashboard | SPA | callbacks `/auth`, `/silent-auth`, `/`; web origin and logout `https://netbird.starslab.qzz.io` |
| NetBird CLI | Native | callbacks `http://localhost:53000/`, `http://localhost:54000/`; grants code, refresh token, device code |
| NetBird Management | M2M | Management API grant: read/update/create users and app_metadata |

Google and the username/password connection are enabled for the dashboard
and CLI applications. The Google connection still runs on Auth0's shared
developer keys, which do not support silent re-authentication; add a real
Google OAuth client in Auth0 to stop the dashboard asking for a fresh login
when the token expires.

Client ids live in `nixos-config/modules/netbird-server.nix`; only the M2M
client secret is a secret and sits on the Pi. The dashboard reads the
`access_token` (`USE_AUTH0`, audience of the API), and the management
service fills in user names and emails through the Management API.

## Port 443 sharing

The voice bridge terminates its own TLS and renews over TLS-ALPN-01, so it
cannot sit behind an HTTP proxy. nginx's stream module reads the SNI of each
ClientHello and forwards the raw bytes: `voice-bridge.itoken.world` to the
bridge on `127.0.0.1:8443`, anything else to nginx's HTTPS listener on
`127.0.0.1:8444`. Both legs carry the PROXY protocol so the real source address
survives — the bridge's Cloudflare allowlist depends on it (daemon:
`src/proxy_protocol.rs`), and NetBird records peer addresses from it.

## Cutover

1. Build and switch the Pi (`nixos-config` + daemon with PROXY support).
2. Verify on the Pi before touching DNS, with `curl --resolve` against the
   Pi's public IP: dashboard HTML, `/api/users` → 401, management gRPC → 200,
   `/relay` upgrade → 101, STUN on 3478/udp, and the voice bridge still
   answering with its own certificate.
3. Point `netbird.starslab.qzz.io` A record at `203.116.47.202` (TTL already 60).
4. Log in once through Auth0 (see "Identity: Auth0" above); the first
   login owns the account.
5. Stop the five containers on lubancat. Removing its nginx site needs sudo:
   `sudo rm /etc/nginx/sites-enabled/netbird && sudo nginx -t && sudo systemctl reload nginx`.
6. Delete the `coturn.starslab.qzz.io` record.

## Rollback

Until step 5 the old stack is still running: point the A record back at
`203.116.95.146`. The store on the Pi was upgraded to the 0.80 schema on first
start, so changes made on the Pi after cutover (new peers, keys) would be lost
by rolling back; the original 0.70 store is `/root/netbird-migration/management/store.db`.
