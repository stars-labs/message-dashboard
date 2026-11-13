/** The two chat protocols the company gateway exposes. */
export type CompanyAIProtocol = 'anthropic' | 'openai';

/** The two-part prompt every call sends. */
export interface CompanyAIPrompt {
  system: string;
  user: string;
}

/** One model call. */
export interface CompanyAICall {
  baseUrl: string;
  token: string;
  model: string;
  prompt: CompanyAIPrompt;
  protocol?: CompanyAIProtocol | string;
  fetchImpl?: typeof fetch;
}

/** A response body, as the two wire protocols shape it. */
interface CompanyAIResponseBody {
  choices?: Array<{ message?: { content?: unknown } }>;
  content?: Array<{ type?: string; text?: unknown }>;
}

function endpoint(baseUrl: unknown, path: string): string {
  return `${String(baseUrl || '').replace(/\/+$/, '')}${path}`;
}

export function parseCompanyAIContent(payload: CompanyAIResponseBody | null | undefined): unknown {
  let content: unknown = payload?.choices?.[0]?.message?.content
    ?? payload?.content?.find((part) => part?.type === 'text')?.text;
  if (Array.isArray(content)) {
    content = (content as Array<{ text?: unknown }>).map((part) => part?.text || '').join('');
  }
  if (typeof content !== 'string') {
    throw new Error('Company AI response does not contain message content');
  }
  const cleaned = content.trim()
    .replace(/^```(?:json)?\s*/i, '')
    .replace(/\s*```$/, '');
  try {
    return JSON.parse(cleaned);
  } catch {
    throw new Error('Company AI response is not valid JSON');
  }
}

async function postChat({ baseUrl, token, model, prompt, includeResponseFormat, fetchImpl }: {
  baseUrl: string;
  token: string;
  model: string;
  prompt: CompanyAIPrompt;
  includeResponseFormat: boolean;
  fetchImpl: typeof fetch;
}): Promise<Response> {
  const body = {
    model,
    messages: [
      { role: 'system', content: prompt.system },
      { role: 'user', content: prompt.user },
    ],
    temperature: 0,
  };
  if (includeResponseFormat) body.response_format = { type: 'json_object' };

  return fetchImpl(endpoint(baseUrl, '/v1/chat/completions'), {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(60_000),
  });
}

async function postMessages({ baseUrl, token, model, prompt, fetchImpl }: {
  baseUrl: string;
  token: string;
  model: string;
  prompt: CompanyAIPrompt;
  fetchImpl: typeof fetch;
}): Promise<Response> {
  return fetchImpl(endpoint(baseUrl, '/v1/messages'), {
    method: 'POST',
    headers: {
      'x-api-key': token,
      'anthropic-version': '2023-06-01',
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      model,
      max_tokens: 512,
      system: prompt.system,
      messages: [{ role: 'user', content: prompt.user }],
      temperature: 0,
    }),
    signal: AbortSignal.timeout(60_000),
  });
}

export async function callCompanyAI({
  baseUrl,
  token,
  model,
  prompt,
  protocol = 'anthropic',
  fetchImpl = fetch,
}: CompanyAICall): Promise<unknown> {
  let response;
  if (protocol === 'anthropic') {
    response = await postMessages({ baseUrl, token, model, prompt, fetchImpl });
  } else if (protocol === 'openai') {
    response = await postChat({
      baseUrl, token, model, prompt, includeResponseFormat: true, fetchImpl,
    });
    if (response.status === 400 || response.status === 422) {
      response = await postChat({
        baseUrl, token, model, prompt, includeResponseFormat: false, fetchImpl,
      });
    }
  } else {
    throw new Error(`Unsupported company AI protocol: ${protocol}`);
  }
  if (!response.ok) {
    const detail = (await response.text()).slice(0, 500);
    throw new Error(`Company AI request failed (${response.status}): ${detail}`);
  }
  return parseCompanyAIContent(await response.json());
}

// Liveness probe for the company AI endpoint. It must hit the route callAI uses:
// a GET on the bare base URL is not a route here, so it answered 404 and the
// sms_ai loop stopped claiming work while real model calls were succeeding. An
// unauthenticated POST distinguishes a reachable gateway (4xx) from a dead one.
const PROBE_PATH = '/v1/messages';

// This gateway answers the route in ~3.9s, so the previous 5s budget reported a
// healthy endpoint as unreachable on any wobble.
const PROBE_TIMEOUT_MS = 15_000;

export async function companyAIReachable(
  baseUrl: string,
  fetchImpl: typeof fetch = fetch,
  onError: ((error: unknown) => void) | null = null,
): Promise<boolean> {
  try {
    const response = await fetchImpl(endpoint(baseUrl, PROBE_PATH), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: '{}',
      signal: AbortSignal.timeout(PROBE_TIMEOUT_MS),
    });
    return response.status !== 404;
  } catch (error) {
    onError?.(error);
    return false;
  }
}
