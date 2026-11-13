import { describe, expect, test } from 'bun:test';
import * as v from 'valibot';
import { readBody } from './request-body.js';

const Body = v.object(
  {
    name: v.pipe(v.string('name must be text'), v.nonEmpty('name must not be empty')),
    count: v.number('count must be a number'),
    note: v.optional(v.string('note must be text')),
  },
  'Body must be a JSON object',
);

const options = { name: 'name is required', count: 'count is required' };

function bodyOf(text: string) {
  return { text: () => Promise.resolve(text) };
}

describe('readBody', () => {
  test('returns the parsed body', async () => {
    expect(await readBody(bodyOf('{"name":"a","count":1}'), Body, options)).toEqual({
      ok: true,
      value: { name: 'a', count: 1 },
    });
  });

  test('answers the not-JSON message for text that is not JSON', async () => {
    expect(await readBody(bodyOf('{"name":'), Body, options)).toEqual({
      ok: false,
      error: 'Body must be JSON',
    });
  });

  test('answers the object message for JSON that is not an object', async () => {
    for (const text of ['null', '"x"', '7']) {
      expect(await readBody(bodyOf(text), Body, options)).toEqual({
        ok: false,
        error: 'Body must be a JSON object',
      });
    }
  });

  test('reads an array as an object without the required fields, as valibot does', async () => {
    expect(await readBody(bodyOf('[]'), Body, options)).toEqual({
      ok: false,
      error: 'name is required',
    });
  });

  test('answers the missing-key message for an absent required field', async () => {
    expect(await readBody(bodyOf('{"count":1}'), Body, options)).toEqual({
      ok: false,
      error: 'name is required',
    });
    expect(await readBody(bodyOf('{"name":"a"}'), Body, options)).toEqual({
      ok: false,
      error: 'count is required',
    });
  });

  test("answers the validator's own message for a present but invalid field", async () => {
    expect(await readBody(bodyOf('{"name":"","count":1}'), Body, options)).toEqual({
      ok: false,
      error: 'name must not be empty',
    });
    expect(await readBody(bodyOf('{"name":"a","count":"1"}'), Body, options)).toEqual({
      ok: false,
      error: 'count must be a number',
    });
    expect(await readBody(bodyOf('{"name":"a","count":1,"note":7}'), Body, options)).toEqual({
      ok: false,
      error: 'note must be text',
    });
  });
});
