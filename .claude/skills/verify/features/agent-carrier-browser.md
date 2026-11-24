# Balance Agent: carrier-browser capability (manual only)

For carriers without an SMS balance menu (China Unicom, M1), the Balance Agent opens the
carrier's web portal in a visible Chrome, logs in with an SMS one-time code, and reads
the balance and expiry. A human finishes any CAPTCHA or slider.

## Sub-features

- web job: a browser-method balance query writes `sim_balance_checks` (`queued`) and
  `sim_balance_web_jobs` (`pending`); 查询记录 shows BROWSER 等待本机.
- claim: `run --capability carrier-browser` claims the job and opens Chrome with a
  temporary profile.
- OTP: the agent requests the login code and reads it from the SIM's incoming SMS.
- human verification: state `human_verification_required`; a macOS notification and
  the tray item 显示验证窗口 bring the Chrome window forward.
- result: balance and expiry parsed by `shared/m1-web-balance.ts` /
  `shared/unicom-web-balance.ts`.

## How to get to it (user POV)

余额 → 查询 on a browser-profile SIM (S02 in the seed) with a signed-in Balance Agent
running the `carrier-browser` capability.

## Driving it with bun run verify

Only the part before the portal:

```ts
await p.getByRole('row').filter({ hasText: 'S02' })
  .getByRole('button', { name: '查询', exact: true }).click();
await p.getByRole('button', { name: '仍然排队' }).click();
// sim_balance_checks 'queued', sim_balance_web_jobs 'pending' (dashboard-balances.md)
```

Never claim a web job in a journey. From the claim on, coverage is the parsers' unit
tests (`shared/*-web-balance.test.ts`), the workflow's tests
(`balance-agent/src/runner/capabilities/carrier-browser*.test.ts`), the recorded
control exchanges (`shared/control-fixtures/runner/`), and an operator run.

## Gotchas

- Claiming a job drives a real carrier website and asks the carrier to send a real
  login SMS to a real SIM. That is outside the sealed run by design.
- Never automate the CAPTCHA or slider; that is an operator handoff.
- Carriers rate-limit their OTP endpoints and each profile has its own login cooldown;
  keep operator batches small.
