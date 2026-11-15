import * as v from 'valibot';

/** The message for a body that is empty or not JSON. */
export const NOT_JSON_MESSAGE = 'Body must be JSON';

/** The message for a JSON body that is not an object, for schemas that do not need their own. */
const OBJECT_MESSAGE = 'Body must be a JSON object';

type RequiredKeys<T> = {
  [K in keyof T]-?: undefined extends T[K] ? never : K;
}[keyof T];

/**
 * Valibot reports a missing key with the object's message, so each required
 * field names the message it answers when absent. Typed against the entries'
 * input: every required field needs one, and an optional field cannot have one.
 */
type MissingKeyMessages<Entries extends v.ObjectEntries> = Readonly<
  Record<RequiredKeys<v.InferInput<v.ObjectSchema<Entries, undefined>>>, string>
>;

/** The key a missing-key issue names: Valibot writes it quoted in `expected`. */
const MISSING_KEY = /^"(.+)"$/;

/**
 * A JSON object body: a missing required key answers its own message, no body
 * at all `absent` (on a daemon or runner route, a body that is not JSON reads
 * as none), and anything else that is not an object `message`. The messages
 * live in the schema, so every reader of the body (the contract, readBody)
 * reports the same thing.
 */
export function bodyObject<const Entries extends v.ObjectEntries>(
  entries: Entries,
  missing: MissingKeyMessages<Entries>,
  message: string = OBJECT_MESSAGE,
  absent: string = NOT_JSON_MESSAGE,
) {
  return v.object(entries, (issue) => {
    const key = MISSING_KEY.exec(issue.expected)?.[1];
    const own: unknown =
      key !== undefined && Object.hasOwn(missing, key) ? Reflect.get(missing, key) : undefined;
    if (typeof own === 'string') return own;
    return issue.input === undefined ? absent : message;
  });
}
