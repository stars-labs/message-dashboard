// bun run d1:hot-queries [--period 1d] [--min-runs 96] [--min-reads 50]
// Lists production statements that run on a schedule yet read many rows a run.
// Read-only: one `wrangler d1 insights` call. Query Insights counts the Worker's
// statements, not `wrangler d1 execute --file`, so migrations do not appear.
import { join } from 'node:path';
import { parseArgs } from 'node:util';
import * as v from 'valibot';
import { hotQueries, parseInsights, periodDays } from './hot-queries.ts';

const DATABASE = 'sms-dashboard';
const root = join(import.meta.dirname, '..');
const WRANGLER = ['node', join(root, 'node_modules/wrangler/bin/wrangler.js')];

const Count = v.pipe(v.string(), v.toNumber(), v.integer(), v.minValue(1));

const { values } = parseArgs({
  options: {
    period: { type: 'string', default: '1d' },
    'min-runs': { type: 'string', default: '96' },
    'min-reads': { type: 'string', default: '50' },
  },
  strict: true,
});
const period = values.period;
const days = periodDays(period);
const minRunsPerDay = v.parse(Count, values['min-runs']);
const minAvgRowsRead = v.parse(Count, values['min-reads']);

const proc = Bun.spawn(
  [
    ...WRANGLER,
    'd1',
    'insights',
    DATABASE,
    '--time-period',
    period,
    '--sort-by',
    'reads',
    '--limit',
    '100',
    '--json',
  ],
  { cwd: root, stdout: 'pipe', stderr: 'pipe' },
);
const [stdout, stderr, code] = await Promise.all([
  new Response(proc.stdout).text(),
  new Response(proc.stderr).text(),
  proc.exited,
]);
if (code !== 0) throw new Error(`d1 insights failed:\n${stderr}`);

const rows = hotQueries(parseInsights(stdout), { days, minRunsPerDay, minAvgRowsRead });

console.log(`Database ${DATABASE}, the ${period} before ${new Date().toISOString()}`);
console.log(`Statements run at least ${String(minRunsPerDay)} times a day that read at least`);
console.log(`${String(minAvgRowsRead)} rows a run, most rows read first:\n`);
if (rows.length === 0) console.log('None.');
for (const row of rows) {
  console.log(
    `${String(row.runsPerDay).padStart(6)}/day  ${String(row.avgRowsRead).padStart(6)} rows/run  ` +
      `${String(row.totalRowsRead).padStart(10)} read  ${String(row.totalRowsWritten).padStart(8)} written`,
  );
  console.log(`  ${row.query.slice(0, 200)}\n`);
}
