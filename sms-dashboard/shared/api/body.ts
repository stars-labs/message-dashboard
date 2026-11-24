import * as v from 'valibot';

export const NOT_JSON_MESSAGE = 'Body must be JSON';

const OBJECT_MESSAGE = 'Body must be a JSON object';

type RequiredKeys<T> = {
  [K in keyof T]-?: undefined extends T[K] ? never : K;
}[keyof T];

/** Valibot reports a missing key with the object's message, so each required field names its own. */
type MissingKeyMessages<Entries extends v.ObjectEntries> = Readonly<
  Record<RequiredKeys<v.InferInput<v.ObjectSchema<Entries, undefined>>>, string>
>;

// Valibot writes the missing key quoted in `expected`.
const MISSING_KEY = /^"(.+)"$/;

/**
 * No body answers `absent` (on a daemon or runner route, a body that is not JSON reads as
 * none); anything else that is not an object answers `message`.
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
