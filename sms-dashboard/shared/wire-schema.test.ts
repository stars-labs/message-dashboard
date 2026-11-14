import { describe, expect, test } from 'bun:test';
import * as v from 'valibot';
import { acceptsWire } from './wire-schema.js';

interface Wire {
  id: string;
  count: number;
  note: string | null;
  extra?: boolean;
  items: { name: string; flag?: number }[];
  at: string;
}

describe('acceptsWire', () => {
  const Tolerant = v.object({
    id: v.string(),
    count: v.number(),
    note: v.nullish(v.string()),
    extra: v.optional(v.boolean()),
    items: v.array(v.object({ name: v.string(), flag: v.nullish(v.number()) })),
  });

  test('returns the schema unchanged when it accepts the wire type', () => {
    const schema = acceptsWire<Wire, 'at'>()(Tolerant);
    expect(schema).toBe(Tolerant);
    expect(v.safeParse(schema, { id: 'a', count: 1, items: [] }).success).toBe(true);
  });

  test('rejects a schema whose field type differs from the wire type', () => {
    const Stricter = v.object({
      id: v.string(),
      count: v.string(),
      note: v.nullish(v.string()),
      extra: v.optional(v.boolean()),
      items: v.array(v.object({ name: v.string(), flag: v.nullish(v.number()) })),
    });
    // @ts-expect-error count is a number on the wire but a string in the schema
    acceptsWire<Wire, 'at'>()(Stricter);
  });

  test('rejects a schema that does not name a wire field', () => {
    // @ts-expect-error `at` is neither declared nor ignored
    acceptsWire<Wire>()(Tolerant);
  });

  test('rejects a schema that does not name a nested wire field', () => {
    const NoFlag = v.object({
      id: v.string(),
      count: v.number(),
      note: v.nullish(v.string()),
      extra: v.optional(v.boolean()),
      items: v.array(v.object({ name: v.string() })),
    });
    // @ts-expect-error items[].flag is not declared
    acceptsWire<Wire, 'at'>()(NoFlag);
  });

  test('rejects a schema that requires a field the wire type may omit', () => {
    const RequiresExtra = v.object({
      id: v.string(),
      count: v.number(),
      note: v.nullish(v.string()),
      extra: v.boolean(),
      items: v.array(v.object({ name: v.string(), flag: v.nullish(v.number()) })),
    });
    // @ts-expect-error extra is optional on the wire
    acceptsWire<Wire, 'at'>()(RequiresExtra);
  });
});
