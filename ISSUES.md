# Known Issues

## Database

### 1. Duplicate SIMs from ICCID trailing `F` padding
**Status**: Open
**Impact**: 121 SIM records instead of ~97 (24 logical duplicates)

ICCID standard pads to 20 digits with `F`. The daemon creates two records for the same physical SIM — one with and one without the trailing `F`.

**23 duplicate pairs found** (queried 2026-03-05):

| ICCID (without F) | ICCID (with F) | Equipment ID | Updated (no F) | Updated (with F) |
|---|---|---|---|---|
| `8965030124051507851` | `8965030124051507851F` | `865827078906716` | 2026-03-04 07:59 | 2026-03-04 09:40 |
| `8965012306052989699` | `8965012306052989699F` | `865827078941325` | 2026-02-12 09:38 | 2026-03-05 05:33 |
| `8965012306052989731` | `8965012306052989731F` | `865827078973013` | 2026-03-04 07:59 | 2026-03-05 05:33 |
| `8965012306052989657` | `8965012306052989657F` | `865827078973062` | 2026-03-04 09:44 | 2026-03-04 09:44 |
| `8965012306052577791` | `8965012306052577791F` | `865827078989076` | 2026-03-04 07:59 | 2026-03-05 05:33 |
| `8965030124051507901` | `8965030124051507901F` | `865827079000667` | 2025-12-29 09:43 | 2025-12-31 04:11 |
| `8965012211290057038` | `8965012211290057038F` | `865827079001152` | 2026-03-04 07:59 | 2026-03-05 05:33 |
| `8965012306052989665` | `8965012306052989665F` | `865827079030235` | 2026-03-04 09:49 | 2026-03-05 05:33 |
| `8965012306052576256` | `8965012306052576256F` | `865827079030318` | 2025-12-29 07:32 | 2026-03-05 05:33 |
| `8965030124051507893` | `8965030124051507893F` | `865827079030748` | 2025-12-31 04:08 | 2025-12-31 04:11 |
| `8965030124051507919` | `8965030124051507919F` | `865827079067088` | 2026-03-04 05:40 | 2026-03-05 05:33 |
| `8965030124051507927` | `8965030124051507927F` | `865827079072385` | 2026-03-04 09:49 | 2026-03-05 05:33 |
| `8965012306052373985` | `8965012306052373985F` | `865827079072971` | 2026-03-04 05:40 | 2026-03-05 05:33 |
| `8965012211290056949` | `8965012211290056949F` | `865827079073110` | 2026-03-04 07:59 | 2026-03-05 05:33 |
| `8965012211290057046` | `8965012211290057046F` | `865827079073193` | 2026-03-04 09:49 | 2026-03-05 05:33 |
| `8965012306052580191` | `8965012306052580191F` | `865827079073235` | 2026-03-04 09:49 | 2026-03-05 05:33 |
| `8965012306052989707` | `8965012306052989707F` | `865827079073318` | 2026-03-04 07:59 | 2026-03-05 05:33 |
| `8965012211290057004` | `8965012211290057004F` | `865827079073391` | 2026-03-04 07:59 | 2026-03-05 05:33 |
| `8965012306052579276` | `8965012306052579276F` | `865827079073417` | 2026-03-04 09:49 | 2026-03-05 05:33 |
| `8965012306052989673` | `8965012306052989673F` | `865827079073458` | 2026-03-04 05:40 | 2026-03-05 05:33 |
| `8965012306052989715` | `8965012306052989715F` | `865827079073474` | 2026-03-04 05:40 | 2026-03-05 05:33 |
| `8965012306052989681` | `8965012306052989681F` | `865827079073482` | 2026-03-04 07:59 | 2026-03-05 05:33 |
| `8965012306052989640` | `8965012306052989640F` | `865827079088241` | 2026-03-04 09:49 | 2026-03-05 05:33 |

**Root cause**: Daemon reads ICCID differently at different times (with/without BCD padding). Per ITU-T E.118, the ICCID is max 19-20 digits. The trailing `F` is a **storage-level filler** in packed BCD (10 octets), not part of the actual ICCID. The canonical form is **without** the `F`.

**Root cause in code** — 3 ICCID entry points, none strip trailing `F`:

1. **`at_modem.rs:340-351`** — `parse_iccid()`: Returns raw ICCID with `F`. Comment acknowledges padding but doesn't strip it. Test at line 1036 confirms `F` is preserved.
2. **`native_dbus.rs:271`** — `get_sim_iccid()`: Returns `sim_proxy.sim_identifier()` from ModemManager D-Bus. ModemManager usually strips `F` but not guaranteed.
3. **`dbus_client.rs:319`** — `get_sim_iccid_busctl()`: Parses raw busctl output, no normalization.

The same modem returns ICCID **with `F`** via AT commands and **without `F`** via D-Bus at different times → creates both records.

**Fix needed**:
1. **Daemon fix**: Strip trailing `F` in `at_modem.rs:parse_iccid()` (primary fix) and add normalization in `dbus_client.rs` and `native_dbus.rs` as safety
2. **DB cleanup**: For each pair, keep the non-`F` version (canonical), migrate data from `F` version, then delete it. Update any `messages.phone_iccid` references
3. **Update tests**: Fix `at_modem.rs:1036-1040` to expect stripped ICCIDs

### 2. Modem `865827078940772` has 6 stale SIM assignments
**Status**: Open
**Impact**: 6 SIMs marked active on one modem, all with no phone number

```
89852122109190418053  active  2025-12-31 03:59:15
89860122801362457439  active  2025-12-29 08:02:23
89860122801362457363  active  2025-12-29 08:12:54
89860122801362457371  active  2025-12-29 08:22:56
89860122801362457355  active  2025-12-31 03:30:51
89860122801362457447  active  2025-12-30 06:37:22
```

These are different ICCIDs (not the trailing `F` issue). Likely SIM cards that were physically swapped through this modem slot but never deactivated.

**Root cause**: SIM swap detection trigger may not have been active when these were inserted, or the daemon re-assigned without clearing old records.
**Fix needed**:
1. DB cleanup: keep only the most recently updated SIM per modem, mark the rest inactive
2. Investigate if daemon properly clears old SIM assignments on swap
