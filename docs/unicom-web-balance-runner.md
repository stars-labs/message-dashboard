# China Unicom Web Balance Runner

## Purpose

China Unicom SIMs in this fleet use independent accounts. The official web
balance page supports random-password login, so the local runner can authenticate
with a one-time SMS already received by the dashboard and query the official
`userinfoquery` endpoint.

This is a browser integration, not a public carrier API. It is deliberately
separate from the AI balance-menu runner.

## Trust Boundary

- Cloudflare Worker and D1 own scheduling, leases, OTP correlation, audit events,
  and normalized balance metrics.
- The local workstation owns the visible Chrome process and carrier session.
- Carrier cookies never leave the temporary browser profile and are deleted after
  each SIM.
- D1 never stores carrier passwords or cookies.
- The runner submits only the verified account number, CNY balance, and parser
  metadata.

## Workflow

```text
pending -> leased -> awaiting_otp -> authenticating -> querying -> completed
                         |                |
                         +-> human_verification_required -+
```

1. A normal balance query selects profile
   `cn-unicom-browser-random-password-v1` and creates one
   `sim_balance_web_jobs` row.
2. `unicom-balance-runner` launches a visible Chrome window with a temporary
   profile and enters the task SIM number on the official page.
3. Immediately before requesting the random password, it records
   `otp_requested_at` in D1.
4. The Worker returns an OTP only when the received message matches the task ICCID,
   allowlisted sender `10010`, request window, and login/random-password context.
5. After login, the browser calls the official endpoint from its own page context,
   using browser-managed cookies.
6. The parser requires exactly one allowlisted balance field and proof that the
   authenticated account equals the task SIM number.
7. The Worker writes `cash_balance` in CNY to the existing balance tables.

Only one OTP request is allowed per task. If the browser exits after requesting an
OTP, the task fails instead of retrying and requesting another code.

The initial profile is discovery-only: an explicit single-SIM query may use it,
but a fleet batch cannot. Promote it to `enabled = 1` only after a live pilot has
validated the current page selectors and response schema.

## Human Verification

The runner is headful. When the official site presents a slider, image challenge,
or other verification, the browser remains open and the job becomes
`human_verification_required`. The runner renews a 15-minute lease while the user
completes the official challenge locally. It never attempts to bypass or outsource
the challenge. Timeout terminalizes the query and does not request another OTP.

## Commands

```bash
nix develop -c unicom-balance-runner --once
nix develop -c unicom-balance-service start
nix develop -c unicom-balance-service status
nix develop -c unicom-balance-service logs
nix develop -c unicom-balance-service stop
```

The wrapper reads only `API_KEY` from `secrets/dev-vars.yaml`. Agents must not run
the secret-consuming runner or service unless the user explicitly authorizes that
exact invocation.

## Rollback

1. Stop `unicom-balance-service`.
2. Set profile `cn-unicom-browser-random-password-v1` to `enabled = 0`.
3. Existing audit and balance records remain readable; no carrier credentials need
   revocation because none are persisted.
