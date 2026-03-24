# ICCID Mapping Page — Responsive Optimization Plan

## Problem Statement

The ICCID Mapping page (`IccidMappings.svelte`) and its dialogs (`IccidMappingDialog.svelte`) are not responsive. On mobile/tablet:
- The filter bar (4 buttons + 1 search input in `flex gap-2`) overflows horizontally with no wrapping
- The 11-column table is only usable via horizontal scroll — no mobile-friendly alternative
- Modals have no `max-height` or scroll container — form fields overflow the viewport on short screens
- The card uses `p-6` unconditionally (via `tech-card`) — too much padding on mobile
- The page header row (`flex justify-between`) doesn't stack on mobile

## Design Constraints

- **No external libraries** — Tailwind utility classes only
- **No backend changes** — frontend-only
- **Repo-consistent patterns** — follow conventions from `MessageComposer.svelte` (mobile/desktop split), `KeywordConfig.svelte` (table + overflow-x), `PhoneList.svelte`/`SimpleMessageView.svelte` (scroll containment)
- **Breakpoints** — Tailwind v3 defaults: `sm` 640px, `lg` 1024px. Project only uses `sm:` and `lg:` — no `md:` breakpoints in existing code
- **Custom classes** — `tech-card` (includes `p-6` via `app.css:19`), `tech-button`, `cyber-input` defined in `app.css`

## Reference Patterns (already in codebase)

| Pattern | Source | Lines |
|---------|--------|-------|
| `flex flex-wrap gap-2` (wrapping toolbar) | `MessageComposer.svelte` | 368, 637 |
| `lg:hidden` / `hidden lg:flex` (mobile/desktop split) | `MessageComposer.svelte` | 199, 445, 718 |
| `max-h-60 overflow-y-auto` (scroll containment) | `MessageComposer.svelte` | 229, 262, 325 |
| `overflow-x-auto` on table wrapper | `KeywordConfig.svelte` | 165 |
| `flex-1 min-h-0 overflow-y-auto` (panel scroll) | `PhoneList.svelte:148`, `SimpleMessageView.svelte:77` |
| `p-4` card padding (compact) | `PhoneDetails.svelte:37` |
| `fixed inset-0 ... max-w-md w-full mx-4` (modal) | `KeywordConfig.svelte:260-261` |
| `px-2 sm:px-4 lg:px-8` (responsive padding) | `App.svelte:858` (stats bar) |

---

## Stages

### Stage 1: Modal Scroll Safety
**Goal**: Prevent Add/Edit modals from overflowing the viewport on short screens.
**Files**: `IccidMappings.svelte` (lines 404-543, 546-686), `IccidMappingDialog.svelte` (lines 92-267)
**Success Criteria**: All three modals remain fully usable on a 667px-tall viewport (iPhone SE). Form content scrolls internally; header + footer buttons stay visible.

**Changes** (3 modals — same pattern for each):

1. On the outer `tech-card` div of each modal, add `max-h-[90vh] flex flex-col` and override the `tech-card` default `p-6` with `!p-0`.
2. Wrap the `<div class="space-y-4">` form body in a scroll container: add `flex-1 min-h-0 overflow-y-auto px-6`.
3. Make the modal title `flex-shrink-0 px-6 pt-6 pb-2`.
4. Make the footer button row `flex-shrink-0 px-6 pb-6 pt-4`.

Concrete class targets:

**Add modal (`IccidMappings.svelte`):**
- Line 409: `tech-card p-6 max-w-md w-full mx-4` → `tech-card !p-0 max-w-md w-full mx-4 max-h-[90vh] flex flex-col`
- Line 410: `<h3>` → add `flex-shrink-0 px-6 pt-6 pb-2`
- Line 412: `<div class="space-y-4">` → `<div class="space-y-4 flex-1 min-h-0 overflow-y-auto px-6">`
- Line 525: `<div class="mt-6 flex justify-end gap-3">` → `<div class="flex-shrink-0 px-6 pb-6 pt-4 flex justify-end gap-3">`

**Edit modal (`IccidMappings.svelte`):**
- Line 551: `tech-card p-6 max-w-md w-full mx-4` → same as above
- Line 552: `<h3>` → same as above
- Line 554: `<div class="space-y-4">` → same as above
- Line 667: `<div class="mt-6 flex justify-end gap-3">` → same as above

**IccidMappingDialog.svelte:**
- Line 96: `tech-card max-w-md w-full mx-4` → `tech-card !p-0 max-w-md w-full mx-4 max-h-[90vh] flex flex-col`
- Line 97: `<h3>` → add `flex-shrink-0 px-6 pt-6 pb-2`
- Line 99: `<div class="space-y-4">` → `<div class="space-y-4 flex-1 min-h-0 overflow-y-auto px-6">`
- Line 230: `<div class="mt-6 flex justify-end gap-3">` → `<div class="flex-shrink-0 px-6 pb-6 pt-4 flex justify-end gap-3">`

**Tests** (manual, TDD-oriented checklist):
- [ ] Open Add modal on 375x667 viewport → all fields visible via scroll, buttons visible without scrolling viewport
- [ ] Open Edit modal on same viewport → same behavior
- [ ] Open IccidMappingDialog on same viewport → same behavior
- [ ] Desktop (1440x900) → modals look identical to before (no visual regression)
- [ ] Modal content with many fields scrolls smoothly with visible scrollbar

**Commit**: `fix(iccid): add scroll containment to Add/Edit/Dialog modals for short viewports`

---

### Stage 2: Filter Bar Wrapping
**Goal**: Filter bar (4 status buttons + search input) wraps naturally on mobile instead of overflowing.
**Files**: `IccidMappings.svelte` (lines 198-229)
**Success Criteria**: On 375px width, buttons wrap to a second row; search input takes full width below. On desktop, layout is unchanged (single row).

**Changes**:

1. Line 198: Change `<div class="mb-4 flex gap-2">` to `<div class="mb-4 flex flex-wrap gap-2">` — follows exact pattern from `MessageComposer.svelte:368`.
2. Lines 223-228 (search input): Change `class="flex-1 px-4 py-2 cyber-input"` to `class="w-full sm:flex-1 sm:w-auto px-4 py-2 cyber-input"`. This makes the input take full width when it wraps to a new line on mobile, but returns to flex-1 behavior on wider screens.

**Tests**:
- [ ] 375px width → buttons wrap to 2 rows, search input on its own row at full width
- [ ] 640px+ width → single row, search input fills remaining space
- [ ] 1440px width → identical to current layout
- [ ] Filter buttons still toggle correctly after layout change

**Commit**: `fix(iccid): wrap filter bar on mobile with flex-wrap`

---

### Stage 3: Page Header Mobile Stacking
**Goal**: "ICCID 映射管理" title and "添加映射" button stack vertically on mobile.
**Files**: `IccidMappings.svelte` (lines 184-195)
**Success Criteria**: On mobile, title and button stack with appropriate spacing. On desktop, unchanged.

**Changes**:

1. Line 184: Change `<div class="tech-card p-6">` to `<div class="tech-card !p-0">` and add an inner wrapper `<div class="p-4 sm:p-6">` around all card content (close before the modals at line 402).
2. Line 185: Change `<div class="flex justify-between items-center mb-6">` to `<div class="flex flex-col sm:flex-row justify-between items-start sm:items-center gap-3 mb-4 sm:mb-6">`.
3. Line 186: Title h2 — reduce from `text-2xl` to `text-xl sm:text-2xl`.

**Tests**:
- [ ] 375px → title and button stack vertically, button aligns left
- [ ] 640px+ → horizontal row, same as current
- [ ] Padding reduces from 24px to 16px on mobile
- [ ] All child content still renders correctly within new wrapper

**Commit**: `fix(iccid): stack page header on mobile, reduce card padding`

---

### Stage 4: Table Mobile Presentation
**Goal**: On mobile (<640px), show a condensed card-list instead of the 11-column table. On desktop, keep the existing table unchanged.
**Files**: `IccidMappings.svelte` (lines 264-399)
**Success Criteria**: Mobile renders a vertical card per SIM with key fields (SIM#, phone, carrier, status, actions). Desktop table is untouched.

**Changes**:

1. Wrap the existing `<div class="overflow-x-auto">` block (lines 265-399) in `<div class="hidden sm:block">` — hide the table on mobile.
2. Add a new sibling block above it: `<div class="sm:hidden space-y-3">` containing card markup.
3. Each mobile card structure:
   ```svelte
   <div class="border border-stone-200 rounded-lg p-3">
     <div class="flex items-center justify-between mb-2">
       <!-- Left: SIM# badge + phone_number (bold) -->
       <!-- Right: status badge -->
     </div>
     <div class="space-y-1 text-sm text-stone-600">
       <!-- ICCID (mono, truncated to last 6 with full in title) -->
       <!-- carrier pill + country flag -->
       <!-- modem UP/DOWN indicator + signal % -->
     </div>
     <div class="mt-2 pt-2 border-t border-stone-100 flex gap-3 text-sm">
       <!-- Edit / Delete buttons -->
     </div>
   </div>
   ```
4. Show only essential fields on mobile: SIM#, phone_number, carrier, status, modem indicator, and actions.
   - ICCID: show truncated (`...` + last 6 digits), full value in `title` attribute
   - Hide: equipment_id, notes, signal quality (secondary data)
5. The empty-state message (`lines 267-270`) must also appear in the mobile block.

**Tests**:
- [ ] 375px → card list renders, no horizontal scroll needed
- [ ] Each card shows: SIM index, phone number, carrier badge, status badge, edit/delete
- [ ] ICCID shown truncated (last 6 digits) with full ICCID in title attribute
- [ ] 640px+ → table renders normally, card list hidden
- [ ] Edit button on mobile card opens edit modal correctly (calls `startEdit(mapping)`)
- [ ] Delete button on mobile card triggers delete correctly (calls `handleDeleteMapping(mapping.id)`)
- [ ] Empty state message still shows on mobile when no mappings
- [ ] Status badge colors match the desktop table exactly

**Commit**: `feat(iccid): add mobile card layout for SIM list below sm breakpoint`

---

### Stage 5: App Wrapper Padding
**Goal**: Tighten mobile edge padding on the ICCID page wrapper to match the dashboard's stats bar pattern.
**Files**: `App.svelte` (line 978)
**Success Criteria**: Reduced padding on mobile. No change on desktop.

**Changes**:

1. Line 978: Change `<div class="px-4 lg:px-8 py-6 lg:flex-1 lg:min-h-0 lg:overflow-auto">` to `<div class="px-2 sm:px-4 lg:px-8 py-3 sm:py-6 lg:flex-1 lg:min-h-0 lg:overflow-auto">`. This mirrors the pattern already used at `App.svelte:858` for the stats bar.

**Tests**:
- [ ] Desktop: ICCID page scrolls within its container, no double scrollbar
- [ ] Mobile: reduced edge padding (8px → matches stats bar)
- [ ] Visual consistency with stats bar padding on mobile

**Commit**: `fix(iccid): tighten mobile wrapper padding to match dashboard`

---

## Execution Order (minimal risk)

```
Stage 1 (Modals)     — Zero visual change on desktop; fixes real viewport overflow bug
  |
Stage 2 (Filter bar) — Single class addition; zero breakage risk
  |
Stage 3 (Header)     — Small structural change; contained to header div
  |
Stage 5 (Wrapper)    — One-line class change in App.svelte
  |
Stage 4 (Table/Cards) — Largest change; additive (new markup), existing table untouched
```

Stage 4 is last because it's the most code and the only one that adds new markup. Stages 1-3 + 5 are all class-level tweaks that can each be verified independently in under a minute.

## Files Modified (summary)

| File | Stages | Nature of Change |
|------|--------|------------------|
| `sms-dashboard/client/lib/IccidMappings.svelte` | 1, 2, 3, 4 | Modal scroll, filter wrap, header stack, mobile cards |
| `sms-dashboard/client/lib/IccidMappingDialog.svelte` | 1 | Modal scroll containment |
| `sms-dashboard/client/App.svelte` | 5 | Wrapper padding adjustment |

## Risk Assessment

| Stage | Risk | Reason |
|-------|------|--------|
| 1 | Low | Class additions on existing divs; `!p-0` overrides `tech-card` padding safely |
| 2 | Minimal | Adding `flex-wrap` to existing flex container; no structural change |
| 3 | Low | Structural: adds inner wrapper div; all content stays inside |
| 4 | Medium | New markup block; must duplicate event handlers correctly from table rows |
| 5 | Minimal | Single class string change; follows established pattern |

## Out of Scope

- Backend API changes
- New npm dependencies
- KeywordConfig responsive improvements (separate task)
- Table sorting/pagination
- Dark mode
- Accessibility (a11y) audit beyond basic usability

## Status: Not Started
