# NetBird

The NetBird control plane for `netbird.starslab.qzz.io` runs on the Orange Pi as
NixOS services (management, signal, relay, dashboard), configured in
`nixos-config/modules/netbird-server.nix`. It moved there from lubancat on
2026-10-08; nothing of the old setup is left on lubancat.

- Peers that cannot connect directly fall back to the NetBird relay over 443
  (`rels://…/relay`); the relay also serves STUN on 3478/udp. There is no coturn.
- TLS is nginx with an HTTP-01 certificate (port 80 is forwarded to the Pi).

## Secrets

Root-only files in `/var/lib/netbird-secrets/` on the Pi, listed in the header of
`netbird-server.nix`. Carry `datastore-key` over on any move: the store cannot be
read with another key.

Backups from the 2026-10-08 move (the old `management.json` and `store.db`, and
the pre-Auth0 store) are in `/root/netbird-migration/` on the Pi.

## Identity: Auth0

NetBird authenticates against the starslab Auth0 tenant (`starslab.jp.auth0.com`).

Single-account mode is off: anyone with a Google account can pass Auth0, and in
that mode every such login would join the one network. Each new identity lands
in its own empty account; colleagues join ours only through an invite from the
dashboard, for which the management service creates the Auth0 user through the
M2M application. Self-service signup on the username/password connection is
disabled for the same reason.

Auth0 objects, managed with the auth0 CLI (`nix shell nixpkgs#auth0-cli`):

| Object | Type | Notes |
|---|---|---|
| NetBird API | API | identifier `https://netbird.starslab.qzz.io/api`, scope `api`, offline access |
| NetBird Dashboard | SPA | callbacks `/auth`, `/silent-auth`, `/`; web origin and logout `https://netbird.starslab.qzz.io` |
| NetBird CLI | Native | callbacks `http://localhost:53000/`, `http://localhost:54000/`; grants code, refresh token, device code |
| NetBird Management | M2M | Management API grant: read/update/create users and app_metadata |

Google and the username/password connection are enabled for the dashboard and
CLI applications. The Google connection runs on Auth0's shared developer keys,
which do not support silent re-authentication, so the dashboard asks for a fresh
login whenever the token expires.

Client IDs live in `netbird-server.nix`; only the M2M client secret is secret.

## Port 443 sharing

The voice bridge terminates its own TLS and renews over TLS-ALPN-01, so it cannot
sit behind an HTTP proxy. nginx's stream module reads the SNI of each ClientHello
and forwards the raw bytes: `voice-bridge.itoken.world` to the bridge on
`127.0.0.1:8443`, anything else to nginx's HTTPS listener on `127.0.0.1:8444`.
Both legs carry the PROXY protocol, so the real source address survives: the
bridge's Cloudflare allowlist depends on it (`orange-pi-daemon/src/proxy_protocol.rs`),
and NetBird records peer addresses from it. See [voice-calls.md](voice-calls.md).
