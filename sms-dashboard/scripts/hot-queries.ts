import * as v from 'valibot';
import { parseJson } from '../shared/parse-json.ts';

// The fields of `wrangler d1 insights --json` this report reads.
const Insight = v.object({
  query: v.string(),
  avgRowsRead: v.number(),
  totalRowsRead: v.number(),
  totalRowsWritten: v.number(),
  numberOfTimesRun: v.number(),
});

export type Insight = v.InferOutput<typeof Insight>;

export interface HotQuery {
  query: string;
  runsPerDay: number;
  avgRowsRead: number;
  totalRowsRead: number;
  totalRowsWritten: number;
}

export interface Thresholds {
  days: number;
  minRunsPerDay: number;
  minAvgRowsRead: number;
}

export function parseInsights(text: string): Insight[] {
  const parsed = parseJson(text, v.array(Insight));
  if (!parsed.ok)
    throw new Error(`Query Insights output is not a list of queries: ${parsed.error}`);
  return parsed.value;
}

const PERIOD = /^(\d+)([hd])$/;

export function periodDays(period: string): number {
  const match = PERIOD.exec(period);
  if (match === null)
    throw new Error(`Query Insights period must look like 1h or 7d, not ${period}`);
  const amount = Number(match[1]);
  return match[2] === 'h' ? amount / 24 : amount;
}

// A statement that runs on a schedule and still reads many rows a run usually reads
// history it does not need: an idle poll should find its work through an index.
export function hotQueries(insights: Insight[], thresholds: Thresholds): HotQuery[] {
  return insights
    .map((insight) => ({
      query: insight.query.replaceAll(/\s+/g, ' ').trim(),
      runsPerDay: Math.round(insight.numberOfTimesRun / thresholds.days),
      avgRowsRead: Math.round(insight.avgRowsRead),
      totalRowsRead: insight.totalRowsRead,
      totalRowsWritten: insight.totalRowsWritten,
    }))
    .filter(
      (row) =>
        row.runsPerDay >= thresholds.minRunsPerDay && row.avgRowsRead >= thresholds.minAvgRowsRead,
    )
    .sort((a, b) => b.totalRowsRead - a.totalRowsRead);
}
