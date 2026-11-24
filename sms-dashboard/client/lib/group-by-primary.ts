// An orphan secondary (its primary is not in the filtered set) renders as a top-level row
// at depth 0 rather than vanishing when a carrier filter excludes the primary.

import { textOr } from '../../shared/text.js';

interface GroupableRow {
  iccid?: string | null;
  sim_role?: string | null;
  primary_iccid?: string | null;
}

type GroupedItem<T> = T & { __depth: 0 | 1; __isSecondary: boolean };

export function groupByPrimary<T extends object>(
  items: readonly T[] | null | undefined,
  resolve: (item: T) => GroupableRow | null | undefined,
): GroupedItem<T>[] {
  const keyed = (items ?? []).map((item) => {
    const p: GroupableRow = resolve(item) ?? {};
    return {
      item,
      iccid: p.iccid,
      sim_role: textOr(p.sim_role, 'standalone'),
      primary_iccid: textOr(p.primary_iccid, null),
    };
  });

  const presentIccids = new Set(keyed.map((k) => k.iccid));

  const secondariesByPrimary = new Map<string, typeof keyed>();
  for (const k of keyed) {
    if (k.sim_role === 'secondary' && k.primary_iccid && presentIccids.has(k.primary_iccid)) {
      const list = secondariesByPrimary.get(k.primary_iccid) ?? [];
      list.push(k);
      secondariesByPrimary.set(k.primary_iccid, list);
    }
  }

  const out: GroupedItem<T>[] = [];
  for (const k of keyed) {
    // Bucketed secondaries are re-inserted under their primary below.
    if (
      k.primary_iccid &&
      secondariesByPrimary.get(k.primary_iccid)?.some((c) => c.iccid === k.iccid)
    ) {
      continue;
    }
    out.push({ ...k.item, __depth: 0, __isSecondary: false });
    const children = k.iccid ? secondariesByPrimary.get(k.iccid) : undefined;
    if (children) {
      for (const c of children) {
        out.push({ ...c.item, __depth: 1, __isSecondary: true });
      }
    }
  }
  return out;
}
