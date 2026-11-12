const KEY = 'call';
const LEGACY_KEY = 'voice:active-call';

/** A live call as the fleet object stores it. Shape owned by server/api/calls.ts. */
interface StoredCall {
  id: string;
  state?: string;
  [field: string]: unknown;
}

/** The durable snapshot: which call, which revision, and when it expires. */
interface CallRecord {
  call: StoredCall;
  revision: string;
  expiresAt: number;
}

/** The transaction request the Worker sends. */
interface ChangeRequest {
  call: StoredCall | null;
  expected: string | null;
  ttl: number;
}

/** The subset of Durable Object storage this class uses. */
interface SyncStorage {
  kv: {
    get(key: string): CallRecord | unknown;
    put(key: string, value: unknown): void;
    delete(key: string): void;
  };
  transactionSync<T>(fn: () => T): T;
}

interface DurableContext {
  storage: SyncStorage;
  blockConcurrencyWhile(fn: () => Promise<void>): void;
}

/** The KV namespace used once, to migrate a call from before the Durable Object. */
interface MigrationEnv {
  SESSIONS: { get(key: string): Promise<string | null> };
}

// A single object owns the live call. A revision identifies the exact snapshot
// an asynchronous operation started from.
export class CallState {
  storage: SyncStorage;

  constructor(ctx: DurableContext, env: MigrationEnv) {
    this.storage = ctx.storage;
    ctx.blockConcurrencyWhile(async () => {
      if (this.storage.kv.get('initialized')) return;
      const raw = await env.SESSIONS.get(LEGACY_KEY);
      if (raw) {
        const call = JSON.parse(raw) as StoredCall;
        const ttl = call.state === 'ringing' ? 60 : 3600;
        this.storage.kv.put(KEY, { call, revision: crypto.randomUUID(), expiresAt: Date.now() + ttl * 1000 });
      }
      this.storage.kv.put('initialized', true);
    });
  }

  async fetch(request: Request): Promise<Response> {
    const change = request.method === 'POST' ? (await request.json() as ChangeRequest) : null;
    return this.storage.transactionSync(() => {
      const stored = this.storage.kv.get(KEY) as CallRecord | undefined;
      const current = stored && stored.expiresAt > Date.now() ? stored : null;
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