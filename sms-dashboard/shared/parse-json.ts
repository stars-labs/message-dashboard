import * as v from 'valibot';

export type Parsed<T> = { ok: true; value: T } | { ok: false; error: string };

export type Schema<T> = v.GenericSchema<unknown, T>;

function validate<T>(input: unknown, schema: Schema<T>): Parsed<T> {
  const result = v.safeParse(schema, input);
  return result.success
    ? { ok: true, value: result.output }
    : { ok: false, error: v.summarize(result.issues) };
}

export function parseJson<T>(text: string, schema: Schema<T>): Parsed<T> {
  let input: unknown;
  try {
    input = JSON.parse(text);
  } catch (error) {
    return { ok: false, error: `Invalid JSON: ${String(error)}` };
  }
  return validate(input, schema);
}

/** Reads a Request or Response body. Bodies are read as text so a JSON error is reported, not thrown. */
export async function readJson<T>(
  body: { text(): Promise<string> },
  schema: Schema<T>,
): Promise<Parsed<T>> {
  return parseJson(await body.text(), schema);
}
