import { readdirSync, readFileSync } from 'node:fs';
import { parseJson } from '../shared/parse-json.js';
import { ControlFixture } from '../shared/control-fixtures/fixture.js';

const ROOT = new URL('../shared/control-fixtures/', import.meta.url);

/** Every fixture, named by its path under shared/control-fixtures without `.json`. */
export function controlFixtures(): { name: string; fixture: ControlFixture }[] {
  return readdirSync(ROOT, { recursive: true, encoding: 'utf8' })
    .filter((file) => file.endsWith('.json'))
    .sort()
    .map((file) => {
      const parsed = parseJson(readFileSync(new URL(file, ROOT), 'utf8'), ControlFixture);
      if (!parsed.ok) throw new Error(`${file}: ${parsed.error}`);
      return { name: file.slice(0, -'.json'.length), fixture: parsed.value };
    });
}
