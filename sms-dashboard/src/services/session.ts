import { nanoid } from 'nanoid';

export interface SessionData {
  user: any;
  permissions: string[];
  expiresAt: string;
}

export interface SessionStore {
  get(token: string): Promise<SessionData | null>;
  set(token: string, data: SessionData, ttl?: number): Promise<void>;
  delete(token: string): Promise<void>;
}

/**
 * Cloudflare KV session store
 */
export class KVSessionStore implements SessionStore {
  constructor(private kv: any) {}
  
  async get(token: string): Promise<SessionData | null> {
    const data = await this.kv.get(token, 'json');
    return data;
  }
  
  async set(token: string, data: SessionData, ttl: number = 86400): Promise<void> {
    await this.kv.put(token, JSON.stringify(data), {
      expirationTtl: ttl
    });
  }
  
  async delete(token: string): Promise<void> {
    await this.kv.delete(token);
  }
}

/**
 * In-memory session store for local development
 */
export class MemorySessionStore implements SessionStore {
  private sessions = new Map<string, SessionData>();
  
  async get(token: string): Promise<SessionData | null> {
    const data = this.sessions.get(token);
    if (!data) return null;
    
    // Check expiration
    if (new Date(data.expiresAt) < new Date()) {
      this.sessions.delete(token);
      return null;
    }
    
    return data;
  }
  
  async set(token: string, data: SessionData): Promise<void> {
    this.sessions.set(token, data);
  }
  
  async delete(token: string): Promise<void> {
    this.sessions.delete(token);
  }
}

/**
 * Create session store based on environment
 */
export function createSessionStore(env?: any): SessionStore {
  if (env?.SESSIONS) {
    console.log('[Session] Using Cloudflare KV session store');
    return new KVSessionStore(env.SESSIONS);
  }
  
  console.log('[Session] Using in-memory session store');
  return new MemorySessionStore();
}