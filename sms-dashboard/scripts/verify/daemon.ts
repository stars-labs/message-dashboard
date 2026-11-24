// What the Orange Pi daemon sends to /api/control/* (orange-pi-daemon/src/api_client.rs),
// so a journey can stand in for it. Bodies follow shared/control-fixtures/daemon/.
import * as v from 'valibot';
import { readJson } from '../../shared/parse-json.ts';

export interface DaemonReply {
  status: number;
  body: unknown;
}

export type Daemon = (
  path: string,
  options?: { body?: unknown; sessionId?: string },
) => Promise<DaemonReply>;

export function daemonClient(baseUrl: string, apiKey: string): Daemon {
  return async (path, { body, sessionId } = {}) => {
    const response = await fetch(`${baseUrl}${path}`, {
      method: body === undefined ? 'GET' : 'POST',
      headers: {
        'x-api-key': apiKey,
        ...(sessionId === undefined ? {} : { 'x-daemon-session-id': sessionId }),
        ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    const parsed = await readJson(response, v.unknown());
    return { status: response.status, body: parsed.ok ? parsed.value : null };
  };
}
