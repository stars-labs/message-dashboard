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

/** The chat protocols the company gateway exposes. Settings are parsed with this schema. */
export const CompanyAIProtocol = v.picklist(['anthropic', 'openai']);
export type CompanyAIProtocol = v.InferOutput<typeof CompanyAIProtocol>;

export interface CompanyAICall {
  baseUrl: string;
  token: string;
  model: string;
  prompt: CompanyAIPrompt;
  protocol?: CompanyAIProtocol;
  fetchImpl?: CompanyAIFetch;
}

const TextPart = v.object({ type: v.string(), text: v.optional(v.string()) });

/** Anthropic Messages: the reply is a list of content blocks. */
const MessagesResponse = v.object({ content: v.array(TextPart) });

/** OpenAI Chat Completions: the reply is the first choice's message content. */
const ChatResponse = v.object({
  choices: v.tupleWithRest(
    [v.object({ message: v.object({ content: v.union([v.string(), v.array(TextPart)]) }) })],
    v.unknown(),
  ),
});

/** The gateway may answer in either wire format whichever protocol was called. */
const ResponseBody = v.union([ChatResponse, MessagesResponse]);

function endpoint(baseUrl: string, path: string): string {
  return `${baseUrl.replace(/\/+$/, '')}${path}`;
}

function textOf(parts: v.InferOutput<typeof TextPart>[]): string {
  return parts.map((part) => part.text ?? '').join('');
}

function contentOf(body: v.InferOutput<typeof ResponseBody>): string | undefined {
  if ('choices' in body) {
    const { content } = body.choices[0].message;
    return typeof content === 'string' ? content : textOf(content);
  }
  return body.content.find((part) => part.type === 'text')?.text;
}

function parseCompanyAIContent(payload: unknown): unknown {
  const body = v.safeParse(ResponseBody, payload);
  const content = body.success ? contentOf(body.output) : undefined;
  if (content === undefined) {
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

async function post({
  protocol,
  ...request
}: {
  baseUrl: string;
  token: string;
  model: string;
  prompt: CompanyAIPrompt;
  protocol: CompanyAIProtocol;
  fetchImpl: CompanyAIFetch;
}) {
  switch (protocol) {
    case 'anthropic':
      return postMessages(request);
    case 'openai': {
      const response = await postChat({ ...request, includeResponseFormat: true });
      return response.status === 400 || response.status === 422
        ? postChat({ ...request, includeResponseFormat: false })
        : response;
    }
  }
}

export async function callCompanyAI({
  baseUrl,
  token,
  model,
  prompt,
  protocol = 'anthropic',
  fetchImpl = fetch,
}: CompanyAICall): Promise<unknown> {
  const response = await post({ baseUrl, token, model, prompt, protocol, fetchImpl });
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
