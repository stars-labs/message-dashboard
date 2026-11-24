# Carrier Balance Facts

How each carrier exposes a SIM's balance, what has been tried, and the rules for
adding a query method. The code holds the rest: profiles and whether each is
enabled in `sms-dashboard/migrations/reference-data.sql`, thresholds in
`client/lib/balance-overview.ts`, health reasons and the 35-day stale rule in
`shared/prepaid-health.ts`, the 24-hour manual limit in `server/db/balance-plan.ts`.
Billing of postpaid accounts is in [data-contracts.md](data-contracts.md).

## Adding a query method

- Try methods per carrier in this order, moving on only when the earlier one has
  no verified, reliable balance path: USSD, carrier SMS, an official API or
  business portal, browser automation of the official account page. Never reverse
  engineer a private app API.
- Every network command is on a versioned read-only allowlist in its profile. AI and
  skills follow allowlisted menus; they never invent a USSD code, SMS destination,
  menu choice or browser action, and the dashboard never takes arbitrary AT, SMS or
  USSD input.
- A new profile starts discovery-only on one manually triggered SIM. It is enabled
  for unattended use only after two successful results on different days.
- A reply is matched by ICCID, an allowlisted sender, the profile and a bounded
  window; the sender alone is not enough. A failed or ambiguous parse keeps the raw
  reply and never overwrites the last good metric.
- A modem timeout after submitting the SMS is indeterminate, not a failure: keep
  waiting for the carrier's reply and never queue the same message again (CMHK,
  S66, 2026-08-24, where `Send SMS failed: 0` was the echoed body).
- No portal password, cookie, OTP or app token is stored. OTP, captcha and slider
  checks are an operator handoff.

Every USSD pilot so far (`*100#`, `#100#`) ran on a SIM away from its home network
and got an immediate `ERROR` with no `+CUSD` reply. That says nothing about USSD on
the home network.

## What a metric means

- Health is per SIM. Equal balances or identical messages do not prove that SIMs
  share a wallet; only a carrier account or contract does.
- The latest valid typed metrics (`cash_balance`, `account_expiry`, …) are the
  truth; health is derived from them and never stored. Low balance and approaching
  expiry are independent reasons that can hold at once.
- Recording a recharge does not prove the new balance; a later carrier observation
  must.
- `service_type` is set by a person from a carrier account, contract or bill,
  carrier support, or a service SMS that names the payment type. A parser, amount,
  expiry or recharge never changes it. There is no `hybrid`: deposits, gifts and
  credit on a postpaid account are account detail, not a fourth way to pay.
  Mainland SIMs are `balance_managed`, health driven by verified metrics alone.
- Currency and meaning come from the profile, never from message text alone.
- China Telecom: `当前可用余额` / `当前号码通用余额` is `cash_balance` and drives the
  CNY threshold. `本月已产生费用` is `current_charges`, display only. `应缴费用` /
  `待缴费用` are not arrears; only an amount stated as overdue is. `预存费用余额`
  and `赠送费用余额` are supporting detail and say nothing about the payment type.
  ([入网协议](https://sh.189.cn/pdf/ywfwxy.pdf),
  [广东余额查询](https://gd.189.cn/service/cfy/sj_yecx.htm))

## Carriers

Fleet facts as of 2026-08-24.

**China Mobile** (`cn-mobile-sms-menu-v1`). No nationwide USSD balance code is
published. SMS `10086` → `1` (`话费与AI豆`) → `101` (`查询余额`) returned the CNY
balance on S02 (2026-08-14); it needs a second day before it is enabled.
Provincial keywords (`101`, `YE`, `CXYE`) are not national.

**China Unicom** (`cn-unicom-browser-random-password-v1`). Every SMS route returns
only an app link: `余额`, `102`, `KYYE`, `CXYE` and `YE` to `10010` on S01, S03, S04
and S05. Do not test more aliases without new evidence. The balance comes from the
official web page with a random password sent by `10010`; the Balance Agent keeps
the carrier cookies local. (`101` is current-month charges, not balance.)

**China Telecom** (`cn-telecom-sms-102-v1`). `102` to `10001` returns current
available, total/prepaid and gift balance. S69, S70 and S71 (Huizhou) returned
identical amounts and customer mask: one shared account. The menu route `10001` →
`1` → `102` worked on S55 and stays a discovery fallback.

**Singtel.** The fleet's Singtel lines (S78–S95) are all postpaid; their bills
arrive by SMS on S79. My Account needs a OnePass ID, password and SMS OTP, so it
serves only to check account membership and payments. Prepaid balance is in the
hi!App only; `*100#` and `*139#` come from a 2020 FAQ and are unconfirmed.

**M1** (`sg-m1-prepaid-browser-v1`). S73–S77 are M1 prepaid.
`https://mcardaccount.m1.com.sg/login` takes the eight-digit number and a six-digit
SMS OTP and shows the SGD balance and `Valid Till` expiry. `#100#` has not been
tried on a genuine M1 SIM.

**StarHub.** No SIM in the fleet is verified StarHub; lines once labelled StarHub
turned out to be Singtel. `*123#` was retired on 2024-06-30, there is no SMS
balance keyword (`CHECK` to `78989` is DataTravel only), and balance needs the app
or a Hub iD with password and OTP. Manual only.

**CMHK** (`hk-cmhk-sms-menu-v1`). `0` to `12580` opens the free SMS service hall and
works while roaming (S66). `*#130#` is data balance on some products, never cash.
S67 is untested.
