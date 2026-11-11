const KEY = 'call';
const LEGACY_KEY = 'voice:active-call';

// A single object owns the live call. A revision identifies the exact snapshot
// an asynchronous operation started from.
export class CallState {
  constructor(ctx, env) {
    this.storage = ctx.storage;
    ctx.blockConcurrencyWhile(async () => {
      if (this.storage.kv.get('initialized')) return;
      const raw = await env.SESSIONS.get(LEGACY_KEY);
      if (raw) {
        const call = JSON.parse(raw);
        const ttl = call.state === 'ringing' ? 60 : 3600;
        this.storage.kv.put(KEY, { call, revision: crypto.randomUUID(), expiresAt: Date.now() + ttl * 1000 });
      }
      this.storage.kv.put('initialized', true);
    });
  }

  async fetch(request) {
    const change = request.method === 'POST' ? await request.json() : null;
    return this.storage.transactionSync(() => {
      const stored = this.storage.kv.get(KEY);
      const current = stored?.expiresAt > Date.now() ? stored : null;
      if (!change) return Response.json(current);
      const { call, expected, ttl } = change;
      if ((current?.revision ?? null) !== expected) return Response.json(null, { status: 409 });
      if (!call) {
        this.storage.kv.delete(KEY);
        return Response.json(null);
      }
      const revision = crypto.randomUUID();
      this.storage.kv.put(KEY, { call, revision, expiresAt: Date.now() + ttl * 1000 });
      return Response.json(revision);
    });
  }
}
