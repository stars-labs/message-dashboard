import * as v from 'valibot';
import { parseJson, readJson } from '../../shared/parse-json.js';
import type { KV } from '../lib/kv.js';

const KEY = 'call';
const LEGACY_KEY = 'voice:active-call';

const LegacyCall = v.looseObject({ state: v.optional(v.unknown()) });

const CallRecord = v.object({
  call: v.unknown(),
  revision: v.string(),
  expiresAt: v.number(),
});

const ChangeRequest = v.object({
  call: v.unknown(),
  expected: v.optional(v.nullable(v.string())),
  ttl: v.number(),
});

interface SyncStorage {
  kv: {
    get(key: string): unknown;
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
  SESSIONS: KV<'get'>;
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
        const parsed = parseJson(raw, LegacyCall);
        if (!parsed.ok) throw new Error(`Stored call is unreadable: ${parsed.error}`);
        const call = parsed.value;
        const ttl = call.state === 'ringing' ? 60 : 3600;
        this.storage.kv.put(KEY, {
          call,
          revision: crypto.randomUUID(),
          expiresAt: Date.now() + ttl * 1000,
        });
      }
      this.storage.kv.put('initialized', true);
    });
  }

  async fetch(request: Request): Promise<Response> {
    let change: v.InferOutput<typeof ChangeRequest> | null = null;
    if (request.method === 'POST') {
      const parsed = await readJson(request, ChangeRequest);
      if (!parsed.ok) return Response.json({ error: parsed.error }, { status: 400 });
      change = parsed.value;
    }
    return this.storage.transactionSync(() => {
      const stored = v.safeParse(CallRecord, this.storage.kv.get(KEY));
      const current = stored.success && stored.output.expiresAt > Date.now() ? stored.output : null;
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
