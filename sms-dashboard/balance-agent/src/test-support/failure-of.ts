export async function failureOf(pending: Promise<unknown>): Promise<string> {
  const error = await pending.then(
    () => null,
    (caught: unknown) => caught,
  );
  return error instanceof Error ? error.message : 'did not fail';
}
