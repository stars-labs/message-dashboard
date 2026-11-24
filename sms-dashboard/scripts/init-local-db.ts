// bun run db:init [-- --persist-to <dir>]: a local D1 built as production's database
// before any user data, the way test/schema.ts builds the test databases.
import { readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { baselineThrough, databaseFiles } from './migration-rules.ts';

const root = join(import.meta.dirname, '..');
const migrations = join(root, 'migrations');
const WRANGLER = ['node', join(root, 'node_modules/wrangler/bin/wrangler.js')];

const through = baselineThrough(await Bun.file(join(migrations, 'schema.sql')).text());
for (const name of databaseFiles(await readdir(migrations), through)) {
  const command = [
    ...WRANGLER,
    'd1',
    'execute',
    'sms-dashboard',
    '--local',
    ...process.argv.slice(2),
    '--file',
    join(migrations, name),
    '--yes',
  ];
  const proc = Bun.spawn(command, { cwd: root, stdout: 'pipe', stderr: 'pipe' });
  if ((await proc.exited) !== 0) {
    const output = `${await new Response(proc.stdout).text()}${await new Response(proc.stderr).text()}`;
    throw new Error(`applying ${name} failed:\n${output}`);
  }
}
