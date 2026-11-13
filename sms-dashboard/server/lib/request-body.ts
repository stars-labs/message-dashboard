import * as v from 'valibot';
import { readJson, type Parsed } from '../../shared/parse-json.js';

type RequiredKeys<T> = {
  [K in keyof T]-?: undefined extends T[K] ? never : K;
}[keyof T];

/**
 * Valibot reports a missing key with the object's message, so each required
 * field names the message it answers when absent. Typed against the schema's
 * input: every required field needs one, and an optional field cannot have one.
 */
export type MissingKeyMessages<Schema extends v.GenericSchema> = Readonly<
  Record<RequiredKeys<v.InferInput<Schema>>, string>
>;

function messageOf(issue: v.BaseIssue<unknown>, missingKeyMessages: object): string {
  const key = issue.type === 'object' && issue.path?.length === 1 ? issue.path[0].key : undefined;
  if (typeof key === 'string' && Object.hasOwn(missingKeyMessages, key)) {
    const message: unknown = Reflect.get(missingKeyMessages, key);
    if (typeof message === 'string') return message;
  }
  return issue.message;
}

export const NOT_JSON_MESSAGE = 'Body must be JSON';

/** The message for a JSON body that is not an object, for schemas that do not need their own. */
export const OBJECT_MESSAGE = 'Body must be a JSON object';

/**
 * Reads a JSON request body. The error is the message a 400 should carry:
 * NOT_JSON_MESSAGE, a missing field's message, or the failing validator's own
 * message as declared on the schema.
 */
export async function readBody<Schema extends v.GenericSchema>(
  request: { text(): Promise<string> },
  schema: Schema,
  missingKeyMessages: MissingKeyMessages<Schema>,
): Promise<Parsed<v.InferOutput<Schema>>> {
  const raw = await readJson(request, v.unknown());
  if (!raw.ok) return { ok: false, error: NOT_JSON_MESSAGE };
  const parsed = v.safeParse(schema, raw.value);
  return parsed.success
    ? { ok: true, value: parsed.output }
    : { ok: false, error: messageOf(parsed.issues[0], missingKeyMessages) };
}
