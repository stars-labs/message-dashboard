import type * as v from 'valibot';

type Primitive = string | number | boolean | null | undefined;

type Present<T> = NonNullable<T>;

/**
 * The keys of `Wire`, at any depth, that `Input` does not declare and that are
 * not listed in `Ignored`. A Rust field the schema never names would otherwise
 * be stripped by valibot without anyone noticing.
 */
type UndeclaredKeys<Wire, Input, Ignored extends string> = [Present<Wire>] extends [Primitive]
  ? never
  : [Present<Wire>] extends [readonly (infer WireItem)[]]
    ? [Present<Input>] extends [readonly (infer InputItem)[]]
      ? UndeclaredKeys<WireItem, InputItem, Ignored>
      : never
    : {
        [Key in keyof Present<Wire> & string]-?: Key extends Ignored
          ? never
          : Key extends keyof Present<Input>
            ? UndeclaredKeys<Present<Wire>[Key], Present<Input>[Key], Ignored>
            : Key;
      }[keyof Present<Wire> & string];

type WireCheck<Wire, Schema extends v.GenericSchema, Ignored extends string> = [Wire] extends [
  v.InferInput<Schema>,
]
  ? [UndeclaredKeys<Wire, v.InferInput<Schema>, Ignored>] extends [never]
    ? unknown
    : { readonly schemaDoesNotDeclare: UndeclaredKeys<Wire, v.InferInput<Schema>, Ignored> }
  : { readonly schemaRejectsTheWireType: Wire };

/**
 * Binds a schema to the Rust wire type the daemon sends. The schema may be more
 * tolerant than Rust (a missing nullable field, a looser enum), so the check is
 * that every value of the wire type is an input the schema accepts, and that the
 * schema names every field Rust sends except those in `Ignored`.
 */
export function acceptsWire<Wire, Ignored extends string = never>() {
  return <Schema extends v.GenericSchema>(
    schema: Schema & WireCheck<Wire, Schema, Ignored>,
  ): Schema => schema;
}
