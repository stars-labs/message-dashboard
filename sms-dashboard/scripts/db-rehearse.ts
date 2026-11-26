// bun run db:rehearse <file.sql> [--max-rows-read N] [--max-rows-written N]
// Runs SQL on a copy of production in an isolated local D1 and reports the rows it reads
// and writes as D1 counts them. Production is only read (one full `d1 export`). Exits 1
// when a limit is exceeded, as db:apply would refuse it.
import { parseArgs } from 'node:util';
import { rehearsalReport, REHEARSAL_OPTIONS, rehearseFile } from './rehearsal-command.ts';

const { values, positionals } = parseArgs({
  options: REHEARSAL_OPTIONS,
  allowPositionals: true,
  strict: true,
});
const [file] = positionals;
if (file === undefined || positionals.length > 1) {
  throw new Error(
    'usage: bun run db:rehearse <file.sql> [--max-rows-read N] [--max-rows-written N]',
  );
}

const { rehearsal, violations } = await rehearseFile(file, values);
console.log(rehearsalReport(file, rehearsal));
if (violations.length > 0) {
  console.error(violations.join('\n'));
  process.exitCode = 1;
}
