# SIM Balance Query Plan

## Status

Plan approved on 2026-08-13. No balance-query command has been enabled and no
production SIM has been contacted as part of this plan.

Product, carrier-procedure, technical-design, and rollout decisions are confirmed.
Carrier validation, implementation, and rollout execution remain pending and must
follow the order and safety gates below.

Automated rollout also depends on the observation and rollback gates in the
[SMS Hardware Storage Safety Plan](./sms-hardware-storage-safety-plan.md). Carrier
balance replies use the same physical `ME`/`SM` storage and must not be automated
until storage occupancy and deletion failures are visible.

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
| China | China Mobile | 22 | USSD discovery, then carrier SMS |
| Singapore | StarHub | 14 | Official portal or business account |
| China | China Telecom | 6 | Carrier SMS |
| Singapore | Singtel | 5 | USSD pilot |
| Singapore | M1 | 4 | USSD pilot or prepaid portal |
| Hong Kong | CMHK | 3 | Product-specific command or official account |

Prepaid/postpaid classification is an optional, user-verified inventory field named
`service_type`. It defaults to `unknown` and never blocks a query. The system still
uses only verified carrier query profiles and records the metric actually returned.
An ambiguous response is stored for audit and marked unparsed rather than guessed
to be a balance, charge, arrears value, or service type.

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

- [x] Add user-maintained `service_type` with `unknown`, `prepaid`, and `postpaid`.
  It defaults to `unknown`, never blocks querying, and must not be inferred from the
  carrier, phone number, ICCID, or the presence of balance/arrears text.
- [x] Record a controlled verification source and time for every non-unknown value.
  Treat China Telecom real-time/quasi-real-time prepaid products as `prepaid` for
  operational health; do not add a generic `hybrid` type for prepayments, gifts, or
  credit held by an otherwise postpaid account.
- [x] Product/plan, account owner, and Chinese home province are not required
  inventory fields and do not need manual maintenance.
- [x] Select a carrier query profile using the existing ICCID, country/region, and
  carrier, then discover the supported command from the carrier's official menu or
  a controlled per-SIM test.
- [x] When discovery cannot identify an unambiguous query and metric, mark that SIM
  `unsupported_pending_identification`; do not guess from its phone number.
- [x] Evaluate consolidated business portals only in the corresponding carrier
  confirmation step, not as an inventory prerequisite.

**Exit condition:** service type may remain `unknown`; every SIM is independently
assigned a verified query profile or marked `unsupported_pending_identification`.

## Automation Discovery Order

Apply the following fallback sequence independently to every carrier. A later
method is used only when the earlier method is unsupported, unreliable, or has no
officially verified balance path.

1. **USSD:** verify that the modem and current network mode support `AT+CUSD`, then
   test only an official or otherwise controlled read-only carrier code on one SIM.
2. **Carrier SMS:** discover the live service menu, send only the balance command
   advertised for that SIM, and correlate the reply to the query attempt.
3. **Official API or business integration:** prefer a documented API, supported
   multi-SIM portal, or scheduled export. Do not reverse engineer private app APIs.
4. **Browser automation:** automate the official account page only when no stable
   USSD, SMS, or API path exists. Treat MFA, session expiry, page changes, and
   manual takeover as explicit states.

Skills and AI may orchestrate these verified methods and assist with interpreting
new replies. They must not invent USSD codes, SMS destinations, menu selections,
or browser actions that can change service. Every network command remains on a
versioned read-only allowlist. Discovery starts with one manually triggered SIM;
two successful results on different days are required before unattended use.

### 3. Confirm China Mobile

China Mobile does not currently publish one nationwide USSD balance code in the
official material reviewed for this plan. Some provincial and product-specific
codes may exist, so USSD must still be evaluated first without guessing a code.
Officially, SMS to and from `10086` is supported and `10086` can return the service
menu. Provincial documentation also lists SMS commands such as `101`, `YE`, or
`CXYE`, but those commands must not be assumed to work nationally.

- [x] Pilot procedure approved: select one low-risk China Mobile SIM without
  requiring province/product metadata.
- [x] Confirm the pilot modem firmware and current network mode, run the non-network
  `AT+CUSD=?` capability test, and verify timeout/cancellation behavior.
- [x] Look for an official USSD balance code applicable to that SIM or product. If
  one is found, test it once in a serialized maintenance window, capture the full
  `+CUSD` exchange and DCS, cancel the session, and confirm SMS scanning resumes.
- [x] If no applicable code exists, or USSD is unsupported or unreliable, record
  the reason and fall back to carrier SMS.
- [ ] Send `10086` to `10086` on the pilot SIM and capture the complete menu reply
  only after the USSD path has been closed out.
- [ ] Test only the balance command advertised in that SIM's live menu reply. If the
  reply does not identify one unambiguously, keep the SIM unsupported rather than
  applying a province-level command by inference.
- [ ] Record sender, response latency, encoding, raw content, parsed fields, and any
  charge.
- [ ] Repeat once on another day to confirm a stable reply format.

**Exit condition:** the USSD result is documented and either a versioned USSD or SMS
profile exists for each verified reply variant, with captured fixtures and parser
tests. Unknown variants remain disabled.

#### China Mobile pilot evidence: S02 on 2026-08-14

- SIM: S02, `+8613520607015`, ICCID `898600520121F0517883`.
- Modem: EC20F, firmware `EC20CEHDLGR08A03M1G`, `/dev/ttyUSB268`.
- Registration: roaming (`CREG=5`) on `SGP-M1 CMCC`, FDD LTE band 3. This
  environment is not a China Mobile home-network test.
- Capability: `AT+CUSD=?` returned `+CUSD: (0-2)`; `AT+CUSD=1` and
  `AT+CUSD=2` both returned `OK`.
- No nationwide China Mobile USSD balance code was found in the official material
  reviewed. The commonly reported read-only candidate `*100#` was tested once with
  DCS 15 and once using the modem's default DCS. Both forms returned immediate
  `ERROR` without a `+CUSD` network response; cancellation returned `OK`.
- The daemon was stopped for each serialized maintenance window and was confirmed
  `active` afterwards.

**Pilot conclusion:** USSD balance querying is unavailable for S02 in its current
Singapore roaming/LTE environment. This is not evidence that USSD is unavailable
for all China Mobile SIMs. Continue S02 validation with the live `10086` SMS menu.

Sources: [China Mobile SMS service](https://www.10086.cn/support/service/channel/sms/index.html),
[Jilin Mobile command reference](https://www.jl.10086.cn/support/channelhelp/note).

### 4. Confirm China Unicom

The official service supports sending `10010` to `10010` for a menu and accepts
commands or natural-language requests. Its official command table identifies
`102` as "available balance" and also lists `KYYE`, `CXYE`, `YE`, and `OTACXYE`.
Use numeric command `102` first because it has one explicit read-only meaning;
do not confuse it with `101`, which is current-month charges.

- [x] Pilot procedure approved: select one low-risk China Unicom SIM without
  requiring province/product metadata.
- [x] Close USSD discovery for the first pilot without a network command: no
  official nationwide China Unicom cash-balance USSD code has been verified, so
  guessing a code is outside the read-only allowlist.
- [x] Send `10010` to `10010` on the pilot SIM and capture the live menu.
- [x] Prefer a command explicitly advertised by that menu. If the menu does not
  identify one unambiguously, test the exact text `余额` once on the pilot SIM only.
- [x] Capture the first reply variant; S01 returned only an official app deep link
  for both the service-menu request and the exact `余额` request.
- [ ] Capture the response to official command `102` sent to `10010` on S01.
  The SMS was delivered on 2026-08-14, but no reply had arrived during the
  initial observation window; leave the check awaiting its configured timeout.
- [x] Test official alias `KYYE` on active S03 while S01 remains pending. Use a
  separate discovery profile and check so replies cannot be correlated to the
  wrong SIM or command.
  Check `bal-CiiuYyDoaOGrVyacnIm1q` received the same APP-only response and no
  balance metric; the runtime skill stopped without a follow-up.
- [x] Test official alias `CXYE` on active S04 with its own discovery profile and
  audited check. Check `bal-W-n1122L68mKNggoxOUtW` received the same APP-only
  response and no balance metric; the runtime skill stopped.
- [x] Test the remaining short official alias `YE` on active S05 with a separate
  discovery profile and audited check. Check `bal-1eokUl_1StOk7WKeTVRrk`
  received the same APP-only response; the skill stopped with confidence 1.0.
- [ ] Confirm whether the reply represents stored value, current charges, available
  credit, or arrears.

**Exit condition:** each enabled profile has an unambiguous metric definition and a
tested parser. Do not label current charges as cash balance.

Sources: [China Unicom SMS service](https://iservice.10010.com/service/service_message.html),
[China Unicom official command table](https://iservice.10010.com/elecService/message.html).

### 5. Confirm China Telecom

Guangdong Telecom documents `102` to `10001` for balance, `101` for current charges,
and `108` for data. These are provincial instructions and require validation for
the six actual SIMs.

- [x] Pilot procedure approved: select one low-risk China Telecom SIM without
  requiring province/product metadata.
- [x] Send `10001` to `10001` on the pilot SIM and capture the live menu.
- [x] Test only a balance command explicitly advertised by that live menu. Do not
  assume Guangdong's `102` command applies nationally.
- [x] Distinguish prepaid balance, current charges, arrears, and data allowance.
- [ ] Repeat once and add raw replies as parser fixtures.

**Exit condition:** every enabled Telecom profile is backed by the SIM's captured
live menu and two successful controlled responses on different days.

Source: [Guangdong Telecom SMS commands](https://m.gd.189.cn/gd/sms/).

### 6. Confirm Singtel

Singtel documents `*100#` for prepaid account information and `*139#` for expiry.
The EC20 modem, firmware, network mode, response encoding, and modem backend must all
be tested before USSD can be considered supported.

- [x] Pilot procedure approved without requiring prepaid/product metadata.
- [x] On one modem during a maintenance window, test whether `AT+CUSD` works in its
  current network mode.
- [x] Capture asynchronous `+CUSD` responses, DCS value, menu behavior, and timeout.
- [x] Verify cancellation and that normal SMS scanning resumes afterwards.
- [ ] Compare the result with the official hi!App or account portal.

**Exit condition:** one complete USSD session succeeds twice without blocking SMS
collection. Otherwise classify Singtel as portal/manual until another official
integration is available.

Sources: [Singtel prepaid FAQ](https://www.singtel.com/content/dam/singtel/personal/products-services/mobile/prepaid-plans/prepaid-plans-webpage/03_FAQ.pdf),
[Singtel hi!App](https://www.singtel.com/personal/products-services/mobile/prepaid-plans/hiapp).

#### Singtel pilot evidence: S73 on 2026-08-14

- SIM: S73, `+6590950236`, ICCID `8965030124051507851`.
- Modem: EC20F, `/dev/ttyUSB196`, stable USB path `1-1.2.4.5.3`.
- Registration: `SGP-M1`; the Singtel SIM was not attached to its home network.
- `AT+CUSD=1,"*100#"` returned immediate `ERROR` without a `+CUSD` network
  response. `AT+CUSD=2` returned `OK` and `sms-daemon` was restored to `active`.

**Pilot conclusion:** Singtel USSD is unavailable for S73 in its current network
environment. This does not establish fleet-wide Singtel behavior.

### 7. Confirm M1

M1 documents `#100#`, the M1 Prepaid App, and the Prepaid Portal. `#100#` may require
an interactive USSD session rather than return the desired value directly.

- [x] Pilot procedure approved without requiring prepaid/product metadata.
- [x] Test `#100#` on one modem during a maintenance window.
- [x] Record every menu step; do not hard-code a menu selection before confirming it
  twice.
- [x] Verify timeout, cancellation, encoding, and restoration of SMS scanning.
- [ ] Compare the returned values with the Prepaid Portal.

**Exit condition:** the full interaction is deterministic and tested, or M1 remains
portal/manual.

Source: [M1 prepaid FAQ](https://www.m1.com.sg/support/faq/all-topics/mobile-phones-plans/prepaid).

#### M1 pilot evidence: S78 on 2026-08-14

- SIM: S78, `+6592953543`, ICCID `8965012211290057038`.
- Modem: EC20F, `/dev/ttyUSB42`, stable USB path `3-1.6.3`.
- Registration: `Singtel Singtel`; the M1 SIM was not attached to its home network.
- `AT+CUSD=1,"#100#"` returned immediate `ERROR` without a `+CUSD` network
  response. `AT+CUSD=2` returned `OK` and `sms-daemon` was restored to `active`.

**Pilot conclusion:** M1 USSD is unavailable for S78 in its current network
environment. This does not establish fleet-wide M1 behavior.

### 8. Confirm StarHub

StarHub states that the former `*123#` USSD service no longer works after its 3G
shutdown. Do not implement the legacy command.

- [x] Procedure approved: do not use the obsolete `*123#` command and do not require
  product/account metadata as a prerequisite.
- [x] Confirm the supported self-service scopes: mobile-number login in the StarHub
  App manages only that mobile service; Hub iD login can show the account's linked
  services. The public top-up site is not a balance-query portal.
- [ ] Verify whether the team's Hub iD actually links all 14 inventory SIMs and
  whether My Account exposes their prepaid cash balances, not only usage and bills.
- [ ] Ask StarHub for a business portal, scheduled export, or supported API for this
  fleet size.
- [x] Authentication remains an operator handoff: mobile-number login requires an
  SMS verification code; Hub iD login requires a password and mandatory OTP. Do not
  store or automate these credentials through D1 or the Orange Pi.
- [x] Keep the method manual while no supported machine interface exists; do not reverse
  engineer private mobile-app APIs.

**Exit condition:** an official supported integration is identified, or StarHub is
explicitly recorded as manual-only.

#### StarHub path review and pilot selection: S82 on 2026-08-16

- A read-only production snapshot found all 14 inventory records: 13 were `active`
  and S89 was `offline`. S82-S88 and S90-S94 reported 100% signal; S95 reported
  96%.
- Every active inventory record labelled `Starhub` reported detected operator
  `Singtel Singtel`. The carrier label came from the manual phone-number import,
  not modem detection. Because these cards are physically in Singapore, do not
  describe this discrepancy as StarHub roaming. Reconcile the inventory label with
  the actual subscription before carrier-specific contact.
- S82 (`+6598630587`) is the provisional one-card pilot: active, 100% signal, 12
  stored messages with the latest on 2026-07-15, and no previous balance check.
- **Code/USSD:** no live command was sent. StarHub's service-specific terms say
  Happy `*123#` ceased on 2024-06-30, and its current prepaid guidance says the code
  no longer works after the 3G shutdown.
- **SMS:** no current official SMS command for prepaid cash/main-wallet balance was
  identified, so no guessed message was sent. The current prepaid terms document
  only carrier-pushed SMS alerts for low balance and full utilisation; those alerts
  are useful status signals but cannot supply an on-demand monthly balance. `CHECK`
  to `78989` is documented only for DataTravel roaming-bundle balance and is not a
  cash-balance substitute. Unsupported web claims such as `BAL` to `7007` must not
  enter the allowlist. Historical `*113#` and `*123*1*1#` instructions are USSD,
  not SMS keywords, and are not present in current StarHub guidance.
- A sender-only production summary found 33 messages from `Singtel` across all 14
  StarHub-labelled inventory records and another 15 from `Singtel Biz` across three
  records; it found no `StarHub` sender. Together with every active modem reporting
  `Singtel Singtel`, this makes the manually imported carrier classification unsafe
  to use for a live StarHub test until the subscription ownership is corrected.
- **Account:** current prepaid guidance directs balance queries to the StarHub App.
  Mobile-number login is scoped to one service and uses SMS verification. The web
  My Account portal uses Hub iD plus mandatory OTP and can show linked services, but
  prepaid cash-balance visibility remains unverified. No login attempt was made
  because no interactive browser instance was available in this session.

Sources: [StarHub prepaid terms](https://www.starhub.com/content/dam/starhub/legal-notices-and-terms/consumer/mobile-prepaid.pdf),
[current prepaid top-up and balance guidance](https://www.starhub.com/personal/how-to/how-to-top-up-prepaid-plan.html),
[StarHub App login scopes](https://www.starhub.com/personal/support/article.html?id=PQgmJDBiYfAGdJoih1v2e8),
[My Account authentication](https://www.starhub.com/personal/support/article.html?id=UXSTHae8Tk6M2f2xiaDjS6), and
[DataTravel balance methods](https://www.starhub.com/personal/support/article.html?id=s7vcBy1xPF917NlIkWNdr8).

### 9. Confirm CMHK

Available documentation shows `*#130#` for data balance on some products, but it
does not establish a universal stored-value balance command.

Official CMHK product documentation also identifies sending `0` to `12580` as
the free SMS service-hall entry point. This is suitable for a discovery-only
menu flow: send only `0` initially, then allow the read-only balance skill to
follow an explicit account/balance option returned by `12580`.

- [x] Procedure approved: discover a product-specific method only from an official
  response or account interface; do not require manually maintained product data.
- [ ] Obtain the current product-specific service-code reference.
- [ ] Confirm whether My Account can manage all three SIMs.
- [ ] Test the official `0` to `12580` SMS menu on one online CMHK SIM and retain
  the complete reply chain.
- [ ] Test any product-specific dial command only when explicitly documented for
  that product.
- [ ] Label data allowance as data, not cash balance.

**Exit condition:** each SIM has a product-backed method, or remains manual/pending.

Sources: [CMHK prepaid service tutorial](https://www.hk.chinamobile.com/upload/onlineshop/2025-12-10/Prepaid-Purchasing-Value-Added-Services-Tutorial-EN.pdf),
[CMHK Mobile Duck 2 package documentation](https://www.hk.chinamobile.com/upload/onlineshop/2026-06-05/mobile-duck-2-package-tc.pdf).

#### CMHK SMS pilot evidence: S66 and S67 on 2026-08-14

- Added discovery-only profile `hk-cmhk-sms-menu-v1` from the official instruction
  to send `0` to `12580` to enter the free SMS service hall.
- S66 (`+85246820057`) and S67 (`+85246708256`) were both active but registered
  on `StarHub CMHK`, not the CMHK home network.
- Both outbound attempts failed before submission with
  `Failed to send SMS: Send SMS failed: 0`; neither created a cooldown or received
  a carrier response. S66's modem 108 was also timing out during normal scans.

**Pilot conclusion:** the official SMS menu remains unvalidated because the CMHK
short code could not be submitted while these cards were roaming on StarHub. Retry
only after a CMHK SIM is registered on its home network; do not substitute a guessed
keyword or internationalised form of the short code.

### 10. Confirm the technical design

The design below is approved. Implementation begins only after carrier validation
has produced at least one supported automated profile.

- [x] Define versioned carrier profiles keyed by country/region, carrier, discovered
  reply variant, and method; plan/province are optional rather than required.
- [x] Resolve methods per carrier in the approved order: USSD, carrier SMS, official
  API/business integration, then browser automation.
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

## Implemented Data Shape

Migration `039_add_sim_balance_queries.sql` implements the first SMS discovery
slice. It must be applied before deploying Worker code that reads `messages.purpose`.

```text
sim_balance_profiles
  id, country_code, carrier, method, command, destination,
  expected_senders, parser_version, response_window_minutes,
  discovery_enabled, enabled

sim_balance_checks
  id, sim_iccid, profile_id, requested_at, sent_at, completed_at,
  status, outbound_message_id, response_message_id, response_sender,
  raw_response, error, parser_version

sim_balance_metrics
  id, check_id, metric_type, value, unit, currency, expires_at

messages
  purpose ('user' or 'balance_maintenance'), balance_check_id
```

Suggested `metric_type` values include `cash_balance`, `data_remaining`,
`sms_remaining`, `voice_remaining`, `current_charges`, `arrears`, and
`account_expiry`.

The API-key protected `POST /api/control/balance-checks` endpoint accepts only
`phone_iccid` and `profile_id`. Destination and command are always loaded from an
enabled or discovery-enabled profile. The first profile,
`cn-mobile-sms-menu-v1`, is discovery-only and fixes both destination and command
to `10086`; it is not eligible for scheduled fleet queries.

An inbound reply is correlated only after the daemon reports the outbound SMS as
sent and the check enters `awaiting_response`. Matching requires the same ICCID,
an allowlisted sender, and the profile's bounded response window. The raw reply is
stored on the check and both messages are marked `balance_maintenance`, keeping
them outside the normal inbox, spam drawer, verification extraction, and keyword
processing.

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
| 2026-08-13 | 2a. Prepaid/postpaid metadata | Superseded 2026-08-16 | Original decision was not to maintain or infer account type. The later operational requirement adds user-verified metadata without allowing automatic inference. |
| 2026-08-13 | 2. SIM metadata | Superseded in part | ICCID, region, and carrier still select query profiles; province, plan, and owner remain out of scope. `service_type` is the only added account metadata. |
| 2026-08-16 | 2b. Service type model | Confirmed | Add `unknown`/`prepaid`/`postpaid` plus verification source/time. Existing SIMs remain `unknown`. Query results never auto-write the type. China Telecom can expose available, prepaid, and gift balances even for an account with monthly billing, so typed metrics—not `service_type`—drive recharge and arrears health. Normalize real-time/quasi-real-time prepaid to `prepaid`; do not add an unproven `hybrid` bucket. |
| 2026-08-14 | Automation discovery order | Confirmed | For each carrier, try verified read-only USSD first, then carrier SMS, an official API/business integration, and finally browser automation. AI and skills may orchestrate allowlisted methods but may not invent network commands. |
| 2026-08-14 | 3. China Mobile procedure | First pilot complete | Start with one low-risk SIM and verify EC20 `AT+CUSD` capability plus an applicable official USSD code. If USSD is unavailable or unreliable, close it out explicitly and fall back to the live `10086` SMS menu. S02 completed the first production SMS test; require a second successful test on another day before enabling the profile. |
| 2026-08-14 | 3. China Mobile USSD validation | Closed for S02 | EC20F supports `AT+CUSD`, but `*100#` with and without DCS returned immediate `ERROR` while roaming on SGP-M1 over FDD LTE. No official nationwide USSD balance code was found. Daemon restoration was verified; proceed to the `10086` SMS menu for this SIM. |
| 2026-08-14 | SMS discovery infrastructure | Deployed | Migration 039, Worker version `c5de74fe-9e30-4fe5-828f-2a4a2b3b2f12`, and daemon commit `ade87a3` are in production. Queue items carry their purpose, and the daemon permits digits-only 3-5 digit service codes only for `balance_maintenance`; ordinary sends remain E.164-only. Failed pre-send attempts remain audited but do not consume the 24-hour query allowance. |
| 2026-08-14 | 3. China Mobile SMS validation | First balance confirmed on S02 | Check `bal-ZGNvD9mz1zgFzo3MXG6nc` completed the live allowlisted sequence `10086` → `1` (`话费与AI豆`) → `101` (`查询余额`). The final `10086` reply reported a CNY 264.33 account/general balance, stored as a typed `cash_balance` metric with all six conversation messages retained. The first option-1 attempt timed out waiting for the CMGS prompt and the first retry cleared the residual entry state with `+CMS ERROR: invalid text mode parameter`; the audited retry then succeeded. Migration 040/041 and Worker versions `54c8cb58-c6e3-46bd-be6c-dbe419344aba`/`58596985-b645-45de-b028-4d953dbf5f1a` implement the multi-step flow and restricted failed-step retry. Keep the profile discovery-only until a second successful test on another day. |
| 2026-08-13 | 4. China Unicom procedure | Confirmed | Start with one low-risk SIM, query the live `10010` menu, then use its explicit command or test `余额` once; require stable replies on two different days. No production test performed yet. |
| 2026-08-14 | 4. China Unicom validation | In progress | Selected active S01 (`+8617600419127`) for check `bal-C_033GrXsmEwOR6Hpwuo3`. No verified nationwide cash-balance USSD code was available, so USSD was closed without sending a guessed network command. `10010` to `10010` returned no menu, and the one pre-approved `余额` fallback returned only a China Unicom APP deep link. Further official research found `102` documented specifically as "available balance" (`101` is current-month charges), so continue the same audited check once with `102`. |
| 2026-08-14 | 4. China Unicom `KYYE` validation | APP-only response on S03 | Check `bal-CiiuYyDoaOGrVyacnIm1q` sent the official `KYYE` available-balance alias from active S03 (`+8617600645518`) to `10010`. The carrier returned only the same China Unicom APP deep link and no balance value. The skill stopped safely. |
| 2026-08-14 | 4. China Unicom `CXYE` validation | APP-only response on S04 | Check `bal-W-n1122L68mKNggoxOUtW` sent the official `CXYE` available-balance alias from active S04 (`+8617600642068`) to `10010`. The carrier again returned only the China Unicom APP deep link and no balance value. The skill stopped safely. |
| 2026-08-14 | 4. China Unicom `YE` validation | APP-only response on S05 | Check `bal-1eokUl_1StOk7WKeTVRrk` sent the official `YE` available-balance alias from active S05 (`+8617600604190`) to `10010`. The carrier returned the same APP-only response. Across S01/S03/S04/S05, `102`, `KYYE`, `CXYE`, and `YE` did not expose a balance by SMS. Treat the SMS path as unavailable for this card cohort and move to an official API/business integration or authenticated browser path; do not spend more cards testing equivalent aliases without new evidence. |
| 2026-08-14 | 4. China Unicom authenticated web path | Implementation ready for controlled pilot | Profile `cn-unicom-browser-random-password-v1` creates durable browser jobs. A visible local Chrome Runner requests one random password, obtains only the matching `10010` OTP for the same ICCID and request window, pauses for official human verification when required, calls `userinfoquery` in the authenticated page context, verifies the account number, and stores only the normalized CNY balance. Carrier cookies remain local and ephemeral. Run a one-card selector/response-schema pilot before leaving the service enabled unattended. |
| 2026-08-13 | 5. China Telecom procedure | Confirmed | Start with one low-risk SIM, query the live `10001` menu, and use only a command explicitly returned there; require stable replies on two different days. Do not assume Guangdong `102` nationally. No production test performed yet. |
| 2026-08-14 | 5. China Telecom validation | First balance confirmed on S55 | Check `bal-fXSYXBd2kfKbWhTrHnD10` completed the live sequence `10001` -> `1` (`话费积分`) -> `102` (`余额欠费查询`). The final `10001` reply stated `当前号码通用余额为140.76元`, `应缴费用是0元`, `本月已产生费用为149元`, and `待缴费用为0元`. Only the unambiguous CNY 140.76 general balance was stored as `cash_balance`. The runtime skill made three validated decisions with no errors. Keep the profile discovery-only until a second successful test on another day. |
| 2026-08-14 | 5. Guangdong Telecom direct-command validation | Confirmed on S69/S70/S71 | The Huizhou cohort returned a Guangdong Telecom menu where option `1` led only to an App/WeChat points-query notice. Profile `cn-telecom-sms-102-v1` sent the provincially documented read-only command `102` directly to `10001`; all three cards returned current available balance CNY 86.36, total/prepaid balance CNY 263.36, and gift balance CNY 0.00. The identical customer mask and amounts strongly indicate a shared carrier account. Use current available balance for recharge health and preserve total/prepaid balance as supporting detail. This profile is now the default for the current Telecom fleet; the service-menu profile remains a discovery fallback. |
| 2026-08-13 | 6. Singtel procedure | Confirmed | Pilot `*100#` through a serialized, cancellable `AT+CUSD` maintenance-window test. Validation pending. |
| 2026-08-14 | 6. Singtel validation | Closed for S73 | S73 on `/dev/ttyUSB196`, registered to `SGP-M1`, returned immediate `ERROR` for `*100#` with no `+CUSD` network response. Cancellation returned `OK`; `sms-daemon` was restored and verified active. Do not generalize beyond this SIM/network state. |
| 2026-08-13 | 7. M1 procedure | Confirmed | Pilot the `#100#` interactive USSD flow with timeout/cancellation and portal comparison. Validation pending. |
| 2026-08-14 | 7. M1 validation | Closed for S78 | S78 on `/dev/ttyUSB42`, registered to `Singtel Singtel`, returned immediate `ERROR` for `#100#` with no `+CUSD` network response. Cancellation returned `OK`; `sms-daemon` was restored and verified active. Do not generalize beyond this SIM/network state. |
| 2026-08-13 | 8. StarHub procedure | Confirmed | Never use obsolete `*123#`; investigate only an official portal, business export, or supported API. Validation pending. |
| 2026-08-16 | 8. StarHub path review and pilot selection | Code and on-demand SMS closed; account validation pending | Production had 14 StarHub-labelled inventory records, 13 active and S89 offline. S82 was selected provisionally with 100% signal, recent stored messages, and no balance history. No USSD was sent because official terms retired `*123#` on 2024-06-30. No SMS was sent because no official prepaid cash-balance keyword exists; current terms promise only carrier-pushed low-balance/full-utilisation alerts, and `CHECK` to `78989` is DataTravel-only. Current prepaid balance lookup is through the StarHub App. Web My Account requires Hub iD plus OTP; actual multi-SIM linkage and prepaid cash-balance visibility still require an operator login. All active records reported `Singtel Singtel`, and sender-only history found `Singtel` messages on all 14 with no `StarHub` sender, so reconcile the manually imported carrier label before live carrier contact rather than calling the discrepancy roaming. |
| 2026-08-13 | 9. CMHK procedure | Confirmed | Use only an officially discovered product-specific method; never treat `*#130#` as universal cash balance. Validation pending. |
| 2026-08-14 | 9. CMHK SMS validation | Blocked by roaming short-code submission | Added discovery-only `0` -> `12580` from current official CMHK product documentation. S66 and S67 were both registered on `StarHub CMHK`; both sends failed before submission with daemon error `Send SMS failed: 0`, so no carrier menu was received and no cooldown was consumed. Retry only on the CMHK home network. |
| 2026-08-13 | 10. Technical design | Confirmed | Versioned profiles, immutable audit records, typed metrics, strict correlation, modem serialization, command allowlist, and monthly scheduling approved. Implementation pending carrier validation. |
| 2026-08-13 | 11. Staged rollout | Confirmed | One SIM, then up to five for seven days, then gradual verified-profile rollout with reconciliation and separate alerts. Execution pending. |
