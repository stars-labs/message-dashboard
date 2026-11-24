import * as v from 'valibot';

const PlanRow = v.object({ detail: v.string() });

export function planDetails(rows: unknown): string[] {
  return v.parse(v.array(PlanRow), rows).map(({ detail }) => detail);
}
