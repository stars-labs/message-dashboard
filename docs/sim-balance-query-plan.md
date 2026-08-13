# SIM Balance Query Plan

## Status

Plan approved on 2026-08-13. No balance-query command has been enabled and no
production SIM has been contacted as part of this plan.

Product, carrier-procedure, technical-design, and rollout decisions are confirmed.
Carrier validation, implementation, and rollout execution remain pending and must
follow the order and safety gates below.

## Goal

Provide a reliable, auditable view of the useful balance state for every managed
SIM without disrupting message collection or sending unsafe or obsolete carrier
commands.

"Balance" is not a single value. The system may need to track:

- Stored-value or cash balance and currency.
- Remaining data, SMS, or voice allowance.
- Plan or SIM expiry date.
- Current charges, arrears, or account status for postpaid SIMs.
- The time and outcome of the last successful query.

## Current Inventory

Production currently contains 95 SIM records:

| Country/region | Carrier | SIMs | Proposed first method |
| --- | --- | ---: | --- |
| China | China Unicom | 41 | Carrier SMS |
| China | China Mobile | 22 | Carrier SMS |
| Singapore | StarHub | 14 | Official portal or business account |
| China | China Telecom | 6 | Carrier SMS |
| Singapore | Singtel | 5 | USSD pilot |
| Singapore | M1 | 4 | USSD pilot or prepaid portal |
| Hong Kong | CMHK | 3 | Product-specific command or official account |

Prepaid/postpaid classification is not a required inventory field. The system uses
only verified carrier query profiles and records the metric actually returned. An
ambiguous response is stored for audit and marked unparsed rather than guessed to
be a balance, charge, or arrears value.

## Confirmation Sequence

### 1. Confirm the product requirement

- [x] First release metrics confirmed on 2026-08-13:
  - Prepaid: cash balance, currency, and account/SIM expiry.
  - Postpaid: current charges and arrears status.
  - All SIMs: last successful query time and query status.
  - Deferred: data, SMS, and voice allowance.
- [x] Low-balance and stale-data thresholds:
  - Mainland China SIM: low balance below CNY 100.
  - Singapore SIM: low balance below SGD 10.
  - Hong Kong SIM: low balance below HKD 100.
  - Normal query cadence: once per calendar month.
  - A SIM below its regional threshold enters the recharge-needed list.
  - Failed monthly query: retry once per day, at most three retries.
  - After three failed retries: stop automatic attempts, mark the SIM as query
    failed, and require manual handling.
  - Account/SIM expiry within 30 days: add to the action-needed list with an expiry
    reason separate from low balance.
  - Last successful result older than 35 days: mark the balance data stale.
- [x] Administrators may manually request a refresh. A SIM may be queried manually
  at most once in any 24-hour period; the limit also applies after failures.
- [x] Balance replies are maintenance records. They do not appear as verification
  codes, marketing messages, or ordinary inbox messages. Preserve the complete raw
  reply in the balance-query audit record for troubleshooting and parser updates.

**Exit condition:** one written definition of the fields the dashboard must show and
what constitutes low, stale, unavailable, and failed.

### 2. Confirm SIM account metadata

- [x] Prepaid versus postpaid classification is not required. Do not block querying
  on this metadata and do not infer it from the carrier or phone number.
- [x] Product/plan, account owner, and Chinese home province are not required
  inventory fields and do not need manual maintenance.
- [x] Select a carrier query profile using the existing ICCID, country/region, and
  carrier, then discover the supported command from the carrier's official menu or
  a controlled per-SIM test.
- [x] When discovery cannot identify an unambiguous query and metric, mark that SIM
  `unsupported_pending_identification`; do not guess from its phone number.
- [x] Evaluate consolidated business portals only in the corresponding carrier
  confirmation step, not as an inventory prerequisite.

**Exit condition:** no additional manually maintained metadata is required. During
rollout, every SIM is either assigned a verified query profile or marked
`unsupported_pending_identification`.

### 3. Confirm China Mobile

Officially, SMS to and from `10086` is supported and `10086` can return the service
menu. Provincial documentation also lists commands such as `101`, `YE`, or `CXYE`,
but those commands must not be assumed to work nationally.

- [x] Pilot procedure approved: select one low-risk China Mobile SIM without
  requiring province/product metadata.
- [ ] Send `10086` to `10086` on the pilot SIM and capture the complete menu reply.
- [ ] Test only the balance command advertised in that SIM's live menu reply. If the
  reply does not identify one unambiguously, keep the SIM unsupported rather than
  applying a province-level command by inference.
- [ ] Record sender, response latency, encoding, raw content, parsed fields, and any
  charge.
- [ ] Repeat once on another day to confirm a stable reply format.

**Exit condition:** a versioned profile exists for each verified reply variant, with
captured fixtures and parser tests. Unknown variants remain disabled.

Sources: [China Mobile SMS service](https://www.10086.cn/support/service/channel/sms/index.html),
[Jilin Mobile command reference](https://www.jl.10086.cn/support/channelhelp/note).

### 4. Confirm China Unicom

The official service supports sending `10010` to `10010` for a menu and accepts
commands or natural-language requests. A single nationwide direct balance command
has not yet been verified.

- [x] Pilot procedure approved: select one low-risk China Unicom SIM without
  requiring province/product metadata.
- [ ] Send `10010` to `10010` on the pilot SIM and capture the live menu.
- [ ] Prefer a command explicitly advertised by that menu. If the menu does not
  identify one unambiguously, test the exact text `余额` once on the pilot SIM only.
- [ ] Capture reply variants for prepaid and postpaid accounts separately.
- [ ] Confirm whether the reply represents stored value, current charges, available
  credit, or arrears.

**Exit condition:** each enabled profile has an unambiguous metric definition and a
tested parser. Do not label current charges as cash balance.

Source: [China Unicom SMS service](https://iservice.10010.com/service/service_message.html).

### 5. Confirm China Telecom

Guangdong Telecom documents `102` to `10001` for balance, `101` for current charges,
and `108` for data. These are provincial instructions and require validation for
the six actual SIMs.

- [x] Pilot procedure approved: select one low-risk China Telecom SIM without
  requiring province/product metadata.
- [ ] Send `10001` to `10001` on the pilot SIM and capture the live menu.
- [ ] Test only a balance command explicitly advertised by that live menu. Do not
  assume Guangdong's `102` command applies nationally.
- [ ] Distinguish prepaid balance, current charges, arrears, and data allowance.
- [ ] Repeat once and add raw replies as parser fixtures.

**Exit condition:** every enabled Telecom profile is backed by the SIM's captured
live menu and two successful controlled responses on different days.

Source: [Guangdong Telecom SMS commands](https://m.gd.189.cn/gd/sms/).

### 6. Confirm Singtel

Singtel documents `*100#` for prepaid account information and `*139#` for expiry.
The EC20 modem, firmware, network mode, response encoding, and modem backend must all
be tested before USSD can be considered supported.

- [x] Pilot procedure approved without requiring prepaid/product metadata.
- [ ] On one modem during a maintenance window, test whether `AT+CUSD` works in its
  current network mode.
- [ ] Capture asynchronous `+CUSD` responses, DCS value, menu behavior, and timeout.
- [ ] Verify cancellation and that normal SMS scanning resumes afterwards.
- [ ] Compare the result with the official hi!App or account portal.

**Exit condition:** one complete USSD session succeeds twice without blocking SMS
collection. Otherwise classify Singtel as portal/manual until another official
integration is available.

Sources: [Singtel prepaid FAQ](https://www.singtel.com/content/dam/singtel/personal/products-services/mobile/prepaid-plans/prepaid-plans-webpage/03_FAQ.pdf),
[Singtel hi!App](https://www.singtel.com/personal/products-services/mobile/prepaid-plans/hiapp).

### 7. Confirm M1

M1 documents `#100#`, the M1 Prepaid App, and the Prepaid Portal. `#100#` may require
an interactive USSD session rather than return the desired value directly.

- [x] Pilot procedure approved without requiring prepaid/product metadata.
- [ ] Test `#100#` on one modem during a maintenance window.
- [ ] Record every menu step; do not hard-code a menu selection before confirming it
  twice.
- [ ] Verify timeout, cancellation, encoding, and restoration of SMS scanning.
- [ ] Compare the returned values with the Prepaid Portal.

**Exit condition:** the full interaction is deterministic and tested, or M1 remains
portal/manual.

Source: [M1 prepaid FAQ](https://www.m1.com.sg/support/faq/all-topics/mobile-phones-plans/prepaid).

### 8. Confirm StarHub

StarHub states that the former `*123#` USSD service no longer works after its 3G
shutdown. Do not implement the legacy command.

- [x] Procedure approved: do not use the obsolete `*123#` command and do not require
  product/account metadata as a prerequisite.
- [ ] Check whether the StarHub App/account can manage multiple SIMs.
- [ ] Ask StarHub for a business portal, scheduled export, or supported API for this
  fleet size.
- [ ] Document the permitted authentication and automation model.
- [ ] Keep the method manual if no supported machine interface exists; do not reverse
  engineer private mobile-app APIs.

**Exit condition:** an official supported integration is identified, or StarHub is
explicitly recorded as manual-only.

Source: [StarHub current prepaid top-up guidance](https://www.starhub.com/personal/how-to/how-to-top-up-prepaid-plan.html).

### 9. Confirm CMHK

Available documentation shows `*#130#` for data balance on some products, but it
does not establish a universal stored-value balance command.

- [x] Procedure approved: discover a product-specific method only from an official
  response or account interface; do not require manually maintained product data.
- [ ] Obtain the current product-specific service-code reference.
- [ ] Confirm whether My Account can manage all three SIMs.
- [ ] Test only a command explicitly documented for that product.
- [ ] Label data allowance as data, not cash balance.

**Exit condition:** each SIM has a product-backed method, or remains manual/pending.

Source: [CMHK prepaid service tutorial](https://www.hk.chinamobile.com/upload/onlineshop/2025-12-10/Prepaid-Purchasing-Value-Added-Services-Tutorial-EN.pdf).

### 10. Confirm the technical design

The design below is approved. Implementation begins only after carrier validation
has produced at least one supported automated profile.

- [x] Define versioned carrier profiles keyed by country/region, carrier, discovered
  reply variant, and method; plan/province are optional rather than required.
- [x] Store immutable query attempts separately from the latest derived balance.
- [x] Support multiple typed metrics per response instead of one `balance` column.
- [x] Correlate SMS replies by ICCID, expected service sender, query profile, and a
  bounded request window. Sender alone is insufficient.
- [x] Intercept confirmed maintenance replies before verification-code and spam
  classification while retaining their raw content for audit.
- [x] Serialize modem operations so SMS scanning, outbound SMS, and USSD cannot use
  the same modem concurrently.
- [x] Permit only predefined, read-only carrier commands; never expose arbitrary AT,
  SMS destination, or USSD input through the dashboard.
- [x] Schedule one normal query per calendar month, with jitter, per-carrier rate
  limits, the approved daily retry policy, and an operator-visible audit log.

USSD must be treated as an asynchronous stateful operation. `AT+CUSD` responses can
arrive later as `+CUSD`, can require additional menu input, and need timeout,
decoding, and cancellation behavior. See
[3GPP TS 27.007](https://www.etsi.org/deliver/etsi_ts/127000_127099/127007/17.08.00_60/ts_127007v170800p.pdf).

**Exit condition:** reviewed schema, API, daemon state machine, security boundaries,
and rollback design.

### 11. Confirm staged rollout

- [x] Rollout procedure approved; execution remains pending.
- [ ] Add parser unit tests using sanitized raw replies captured during confirmation.
- [ ] Run one SIM per supported carrier manually.
- [ ] Observe message scanning, outbound sending, modem health, and reply correlation.
- [ ] Expand to five SIMs per carrier and run for at least seven days.
- [ ] Compare dashboard values against carrier portals or apps.
- [ ] Enable the remaining verified profiles gradually.
- [ ] Alert separately for low balance, stale data, unsupported profile, and query
  failure.

**Exit condition:** no disruption to SMS collection, no incorrectly classified
balance replies, and reconciled results for every automated carrier profile.

## Proposed Data Shape

This is a design sketch, not an approved migration.

```text
sim_balance_profiles
  id, country_code, carrier, plan, province, method, command,
  destination, expected_senders, parser_version, enabled

sim_balance_checks
  id, sim_iccid, profile_id, requested_at, completed_at, status,
  raw_response, error, parser_version

sim_balance_metrics
  check_id, metric_type, value, unit, currency, expires_at
```

Suggested `metric_type` values include `cash_balance`, `data_remaining`,
`sms_remaining`, `voice_remaining`, `current_charges`, `arrears`, and
`account_expiry`.

## Safety and Rollback Rules

- A carrier profile starts disabled and requires an explicit production enable.
- One failed or ambiguous parse stores the raw response but does not overwrite the
  last known good metric.
- A query timeout must release the modem and restore normal scanning.
- Balance querying is lower priority than receiving and sending user SMS.
- Disabling the scheduler must stop all new queries without requiring a daemon
  rollback.
- No portal password, session cookie, OTP, or private app token is stored unless an
  official supported integration and secret-management design are approved.

## Decision Log

Record confirmation outcomes here before implementation begins.

| Date | Item | Decision | Evidence/notes |
| --- | --- | --- | --- |
| 2026-08-13 | 1a. First-release metrics | Confirmed | Prepaid: cash balance/currency/expiry. Postpaid: current charges/arrears. All SIMs: last success/query status. Allowances deferred. |
| 2026-08-13 | 1b. Low-balance thresholds | Confirmed | Mainland China: CNY 100. Singapore: SGD 10. Hong Kong: HKD 100. |
| 2026-08-13 | 1c. Query cadence | Confirmed | Query each SIM once per calendar month; place cards below their regional threshold in the recharge-needed list. |
| 2026-08-13 | 1d. Failed-query retry | Confirmed | Retry once per day, at most three times; then stop automatic attempts and require manual handling. |
| 2026-08-13 | 1e. Expiry warning and manual refresh | Confirmed | Warn within 30 days of expiry. Administrators may refresh, limited to once per SIM per 24 hours. |
| 2026-08-13 | 1f. Reply visibility and stale-data definition | Confirmed | Keep raw replies in balance-query audit records only; mark results stale after 35 days without a successful query. |
| 2026-08-13 | 1. Product requirement | Confirmed | All first-release product decisions complete. |
| 2026-08-13 | 2a. Prepaid/postpaid metadata | Not required | Do not maintain or infer account type; store only unambiguous metrics returned by verified profiles. |
| 2026-08-13 | 2. SIM metadata | Confirmed | Use existing ICCID, region, and carrier. Discover commands per SIM; no manual province, plan, owner, or account-type maintenance. |
| 2026-08-13 | 3. China Mobile procedure | Confirmed | Start with one low-risk SIM, discover the command through the live `10086` menu, capture the reply, and require a second successful test on another day. No production test performed yet. |
| | 3. China Mobile validation | Pending | Awaiting controlled tests on the Orange Pi. |
| 2026-08-13 | 4. China Unicom procedure | Confirmed | Start with one low-risk SIM, query the live `10010` menu, then use its explicit command or test `余额` once; require stable replies on two different days. No production test performed yet. |
| | 4. China Unicom validation | Pending | Awaiting controlled tests on the Orange Pi. |
| 2026-08-13 | 5. China Telecom procedure | Confirmed | Start with one low-risk SIM, query the live `10001` menu, and use only a command explicitly returned there; require stable replies on two different days. Do not assume Guangdong `102` nationally. No production test performed yet. |
| | 5. China Telecom validation | Pending | Awaiting controlled tests on the Orange Pi. |
| 2026-08-13 | 6. Singtel procedure | Confirmed | Pilot `*100#` through a serialized, cancellable `AT+CUSD` maintenance-window test. Validation pending. |
| 2026-08-13 | 7. M1 procedure | Confirmed | Pilot the `#100#` interactive USSD flow with timeout/cancellation and portal comparison. Validation pending. |
| 2026-08-13 | 8. StarHub procedure | Confirmed | Never use obsolete `*123#`; investigate only an official portal, business export, or supported API. Validation pending. |
| 2026-08-13 | 9. CMHK procedure | Confirmed | Use only an officially discovered product-specific method; never treat `*#130#` as universal cash balance. Validation pending. |
| 2026-08-13 | 10. Technical design | Confirmed | Versioned profiles, immutable audit records, typed metrics, strict correlation, modem serialization, command allowlist, and monthly scheduling approved. Implementation pending carrier validation. |
| 2026-08-13 | 11. Staged rollout | Confirmed | One SIM, then up to five for seven days, then gradual verified-profile rollout with reconciliation and separate alerts. Execution pending. |
