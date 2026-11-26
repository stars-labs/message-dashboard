// bun run check:schema-drift: compares production D1 with the baseline
// (migrations/schema.sql + reference-data.sql). Read-only: two `d1 export` calls,
// which briefly hold other D1 requests. db:apply runs it after each migration.
import { productionDrift } from './d1-remote.ts';

const drift = await productionDrift();
if (drift.length > 0) {
  console.error(
    `Production differs from the baseline; regenerate it (see migrations/schema.sql):\n${drift.join('\n')}`,
  );
  process.exitCode = 1;
} else {
  console.log('Production matches migrations/schema.sql and reference-data.sql.');
}
