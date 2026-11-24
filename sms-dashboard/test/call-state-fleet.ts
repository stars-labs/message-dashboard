import * as v from 'valibot';
import { CallState } from '../server/handlers/call-state.js';

export interface CallFixture {
  id: string;
  direction: 'inbound' | 'outbound';
  state: 'ringing' | 'connecting' | 'bridging' | 'active' | 'ending' | 'ended';
  iccid: string;
  number: string | null;
  started_at: string;
  session_id?: string;
  adapters?: { up?: string; down?: string };
}

const StoredCall = v.looseObject({ id: v.string(), state: v.string(), iccid: v.string() });
const StoredRecord = v.object({ call: v.unknown(), expiresAt: v.number() });

export interface Fleet {
  getByName(name: string): { fetch(input: string, init?: RequestInit): Promise<Response> };
  call(): unknown;
  current(): v.InferOutput<typeof StoredCall>;
  ttl(): number;
  replace(call: unknown): void;
}

/** The real CallState Durable Object over in-memory storage. */
export function callState(initial: CallFixture | null): Fleet {
  const data = new Map<string, unknown>([['initialized', true]]);
  const object = new CallState(
    {
      storage: {
        kv: {
          get: (key) => data.get(key),
          put: (key, value) => {
            data.set(key, value);
          },
          delete: (key) => {
            data.delete(key);
          },
        },
        transactionSync: (fn) => fn(),
      },
      blockConcurrencyWhile: (fn) => {
        void fn();
      },
    },
    { SESSIONS: { get: () => Promise.resolve(null) } },
  );
  const replace = (call: unknown) => {
    data.set('call', { call, revision: crypto.randomUUID(), expiresAt: Date.now() + 3_600_000 });
  };
  if (initial) replace(initial);
  const call = (): unknown => {
    const stored = v.safeParse(StoredRecord, data.get('call'));
    return stored.success ? stored.output.call : null;
  };
  return {
    getByName: () => ({ fetch: (url, init) => object.fetch(new Request(url, init)) }),
    call,
    current: () => v.parse(StoredCall, call()),
    ttl: () => Math.round((v.parse(StoredRecord, data.get('call')).expiresAt - Date.now()) / 1000),
    replace,
  };
}
