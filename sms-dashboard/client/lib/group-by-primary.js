// Group SIM rows by primary/secondary relationship: secondaries are placed
// immediately after their primary, with a depth marker for indentation.
// Extracted from the inline grouping that used to live in IccidMappings.svelte.
//
// items:   any array whose elements expose iccid / sim_role / primary_iccid
// resolve: optional accessor; defaults to the item itself. The balance page
//          passes (row) => row.phone so it can group on the phone fields while
//          preserving the balance row's checks/health payload.
//
// Returns a flat array (so {#each} renders it directly) of spread items with
// two added keys:
//   __depth        0 for primary/standalone, 1 for secondary
//   __isSecondary  boolean, convenience for class bindings
//
// An orphan secondary (its primary is not in the filtered set) is rendered as
// a top-level row at depth 0 rather than hidden, so a carrier filter that
// excludes the primary never makes a secondary vanish.

export function groupByPrimary(items, resolve = (x) => x) {
  const keyed = (items || []).map((item) => {
    const p = resolve(item) || {};
    return {
      item,
      iccid: p.iccid,
      sim_role: p.sim_role || 'standalone',
      primary_iccid: p.primary_iccid || null,
      sim_index: p.sim_index ?? 999,
    };
  });

  // Preserve the caller's existing sim_index ordering (primary-vs-primary,
  // standalone-vs-standalone); secondaries are re-inserted under their parent.
  keyed.sort((a, b) => a.sim_index - b.sim_index);

  const presentIccids = new Set(keyed.map((k) => k.iccid));

  const secondariesByPrimary = new Map();
  for (const k of keyed) {
    // Only bucket a secondary under a primary that is actually in the set;
    // an orphan (primary filtered out) falls through to render at depth 0.
    if (k.sim_role === 'secondary' && k.primary_iccid && presentIccids.has(k.primary_iccid)) {
      const list = secondariesByPrimary.get(k.primary_iccid) ?? [];
      list.push(k);
      secondariesByPrimary.set(k.primary_iccid, list);
    }
  }

  const out = [];
  for (const k of keyed) {
    // A secondary that was bucketed under a present primary is re-inserted
    // under that primary below; an orphan (primary not in the set) falls
    // through and renders as a top-level row.
    if (secondariesByPrimary.get(k.primary_iccid)?.some((c) => c.iccid === k.iccid)) {
      continue;
    }
    out.push({ ...k.item, __depth: 0, __isSecondary: false });
    const children = secondariesByPrimary.get(k.iccid);
    if (children) {
      for (const c of children) {
        out.push({ ...c.item, __depth: 1, __isSecondary: true });
      }
    }
  }
  return out;
}
