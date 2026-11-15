import { readFileSync } from 'node:fs';
import { ControlFixture } from '../../../shared/control-fixtures/fixture.js';
import { parseJson } from '../../../shared/parse-json.js';

/** A recorded runner exchange from shared/control-fixtures/runner/. */
export function runnerFixture(name: string): ControlFixture {
  const file = new URL(`../../../shared/control-fixtures/runner/${name}.json`, import.meta.url);
  const parsed = parseJson(readFileSync(file, 'utf8'), ControlFixture);
  if (!parsed.ok) throw new Error(`${name}: ${parsed.error}`);
  return parsed.value;
}

/** The Worker's recorded answer, as the control client would receive it. */
export function recordedResponse({ response }: ControlFixture): Response {
  if (response.body === undefined) return new Response(null, { status: response.status });
  return Response.json(response.body, { status: response.status });
}
