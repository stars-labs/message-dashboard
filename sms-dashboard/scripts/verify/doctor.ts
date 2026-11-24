import * as v from 'valibot';

const Binding = v.looseObject({
  binding: v.optional(v.string()),
  remote: v.optional(v.boolean()),
  experimental_remote: v.optional(v.boolean()),
});

/** Bindings marked remote: a local run would read or write real Cloudflare resources through them. */
export function remoteBindings(wranglerToml: string): string[] {
  const config = v.parse(v.record(v.string(), v.unknown()), Bun.TOML.parse(wranglerToml));
  return Object.entries(config).flatMap(([section, value]) => {
    const entries = Array.isArray(value) ? value : [value];
    return entries.flatMap((entry) => {
      const binding = v.safeParse(Binding, entry);
      if (!binding.success) return [];
      const { remote, experimental_remote } = binding.output;
      return remote === true || experimental_remote === true
        ? [`${section}.${binding.output.binding ?? '?'}`]
        : [];
    });
  });
}

/** PIDs, from `ps -axo pid=,command=`, of processes still serving a stack's temp state. */
export function strayStacks(ps: string): string[] {
  return ps
    .split('\n')
    .filter((line) => line.includes('sms-dashboard-stack-'))
    .map((line) => line.trim().split(/\s+/)[0] ?? '')
    .filter((pid) => pid !== '');
}
