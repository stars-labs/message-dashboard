import { readFileSync } from 'node:fs';
import { ControlFixture } from '../../../shared/control-fixtures/fixture.js';
import { parseJson } from '../../../shared/parse-json.js';

export function runnerFixture(name: string): ControlFixture {
  const file = new URL(`../../../shared/control-fixtures/runner/${name}.json`, import.meta.url);
  const parsed = parseJson(readFileSync(file, 'utf8'), ControlFixture);
  if (!parsed.ok) throw new Error(`${name}: ${parsed.error}`);
  return parsed.value;
}

export function recordedResponse({ response }: ControlFixture): Response {
  const init = { status: response.status, headers: response.headers ?? {} };
  if (response.body === undefined) return new Response(null, init);
  return Response.json(response.body, init);
}
