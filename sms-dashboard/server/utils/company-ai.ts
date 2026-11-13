import * as v from 'valibot';
import { parseJson, readJson } from '../../shared/parse-json.js';

/** The two-part prompt every call sends. */
export interface CompanyAIPrompt {
  system: string;
  user: string;
}

export interface CompanyAIRequest {
  method: 'POST';
  headers: Record<string, string>;
  body: string;
  signal: AbortSignal;
}

/** The part of `fetch` a model call uses; the real `fetch` satisfies it. */
export type CompanyAIFetch = (
  url: string,
  init: CompanyAIRequest,
) => Promise<Pick<Response, 'ok' | 'status' | 'text'>>;

/** The part of `fetch` the liveness probe uses. */
export type CompanyAIProbeFetch = (
  url: string,
  init: CompanyAIRequest,
) => Promise<Pick<Response, 'status'>>;

/** One model call. `protocol` is 'anthropic' or 'openai'; anything else is rejected. */
export interface CompanyAICall {
  baseUrl: string;
  token: string;
  model: string;
  prompt: CompanyAIPrompt;
  protocol?: string;
  fetchImpl?: CompanyAIFetch;
}

/** A response body, as the two wire protocols shape it. */
const ResponseBody = v.object({
  choices: v.optional(
    v.array(
      v.object({
        message: v.optional(v.object({ content: v.optional(v.unknown()) })),
      }),
    ),
  ),
  content: v.optional(
    v.array(v.object({ type: v.optional(v.unknown()), text: v.optional(v.unknown()) })),
  ),
});

function endpoint(baseUrl: string, path: string): string {
  return `${baseUrl.replace(/\/+$/, '')}${path}`;
}

function partText(part: unknown): string {
  const text = v.is(v.object({ text: v.unknown() }), part) ? part.text : undefined;
  return typeof text === 'string' || typeof text === 'number' ? String(text) : '';
}

export function parseCompanyAIContent(payload: unknown): unknown {
  const body = v.safeParse(ResponseBody, payload);
  let content: unknown = body.success
    ? (body.output.choices?.[0]?.message?.content ??
      body.output.content?.find((part) => part.type === 'text')?.text)
    : undefined;
  if (Array.isArray(content)) {
    content = content.map((part: unknown) => partText(part)).join('');
  }
  if (typeof content !== 'string') {
    throw new Error('Company AI response does not contain message content');
  }
  const cleaned = content
    .trim()
    .replace(/^```(?:json)?\s*/i, '')
    .replace(/\s*```$/, '');
  const parsed = parseJson(cleaned, v.unknown());
  if (!parsed.ok) throw new Error('Company AI response is not valid JSON');
  return parsed.value;
}

async function postChat({
  baseUrl,
  token,
  model,
  prompt,
  includeResponseFormat,
  fetchImpl,
}: {
  baseUrl: string;
  token: string;
  model: string;
  prompt: CompanyAIPrompt;
  includeResponseFormat: boolean;
  fetchImpl: CompanyAIFetch;
}) {
  const body: {
    model: string;
    messages: { role: string; content: string }[];
    temperature: number;
    response_format?: { type: 'json_object' };
  } = {
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

function postMessages({
  baseUrl,
  token,
  model,
  prompt,
  fetchImpl,
}: {
  baseUrl: string;
  token: string;
  model: string;
  prompt: CompanyAIPrompt;
  fetchImpl: CompanyAIFetch;
}) {
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
      baseUrl,
      token,
      model,
      prompt,
      includeResponseFormat: true,
      fetchImpl,
    });
    if (response.status === 400 || response.status === 422) {
      response = await postChat({
        baseUrl,
        token,
        model,
        prompt,
        includeResponseFormat: false,
        fetchImpl,
      });
    }
  } else {
    throw new Error(`Unsupported company AI protocol: ${protocol}`);
  }
  if (!response.ok) {
    const detail = (await response.text()).slice(0, 500);
    throw new Error(`Company AI request failed (${response.status}): ${detail}`);
  }
  const payload = await readJson(response, v.unknown());
  if (!payload.ok) throw new Error('Company AI response is not valid JSON');
  return parseCompanyAIContent(payload.value);
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
  fetchImpl: CompanyAIProbeFetch = fetch,
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
