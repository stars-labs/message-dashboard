// Runs before `bun run deploy`: the Worker ships only onto a database that already has
// every migration it was built with. The baseline's `through` says which migrations
// production has (db:apply moves it), and the drift check proves production matches it.
import { readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { migrationsDir, productionDrift } from './d1-remote.ts';
import { baselineThrough, pendingMigrations } from './migration-rules.ts';

const through = baselineThrough(await Bun.file(join(migrationsDir, 'schema.sql')).text());
const pending = pendingMigrations(await readdir(migrationsDir), through);
if (pending.length > 0) {
  console.error(
    `Not deployed: production lacks ${pending.join(', ')}. Apply each with bun run db:apply NNN, commit the baseline it regenerates, then deploy.`,
  );
  process.exit(1);
}

const drift = await productionDrift();
if (drift.length > 0) {
  console.error(`Not deployed: production differs from the baseline:\n${drift.join('\n')}`);
  process.exit(1);
}
console.log(`Production has every migration through ${String(through).padStart(3, '0')}.`);
