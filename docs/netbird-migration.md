# NetBird: lubancat → Orange Pi (2026-10-08)

The NetBird control plane for `netbird.starslab.qzz.io` moved from a docker
compose stack on lubancat (0.70.5) to NixOS services on the Orange Pi (0.80.0).
Configuration: `nixos-config/modules/netbird-server.nix`.

## What changed for users

Nothing on purpose. Same domain, same casdoor login, same accounts and setup
keys. Devices reconnected on their own when DNS moved.

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
- `oidc-client-secret` — the casdoor client secret of the NetBird application
- `relay-auth-secret` — generated on the Pi, shared by management and relay

The migration copy of `management.json` and the original `store.db` are kept in
`/root/netbird-migration/` on the Pi. lubancat's `/opt/netbird` is untouched.

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
4. Watch peers reconnect in the dashboard; log in once through casdoor.
5. Stop the five containers on lubancat. Removing its nginx site needs sudo:
   `sudo rm /etc/nginx/sites-enabled/netbird && sudo nginx -t && sudo systemctl reload nginx`.
6. Delete the `coturn.starslab.qzz.io` record.

## Rollback

Until step 5 the old stack is still running: point the A record back at
`203.116.95.146`. The store on the Pi was upgraded to the 0.80 schema on first
start, so changes made on the Pi after cutover (new peers, keys) would be lost
by rolling back; the original 0.70 store is `/root/netbird-migration/management/store.db`.
