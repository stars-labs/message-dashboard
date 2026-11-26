import { handleRequest } from './app.js';
import { runScheduled } from './scheduled.js';
import type { AppRequest } from './worker-context.js';

export default {
  async fetch(incoming: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const request: AppRequest = Object.assign(incoming, { env, ctx });
    return handleRequest(request);
  },

  async scheduled(event: { cron: string; scheduledTime: number }, env: Env) {
    await runScheduled(event, env);
  },
} satisfies ExportedHandler<Env>;
export { CallState } from './handlers/call-state.js';
