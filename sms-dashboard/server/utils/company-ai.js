function endpoint(baseUrl, path) {
  return `${String(baseUrl || '').replace(/\/+$/, '')}${path}`;
}

export function parseCompanyAIContent(payload) {
  let content = payload?.choices?.[0]?.message?.content
    ?? payload?.content?.find((part) => part?.type === 'text')?.text;
  if (Array.isArray(content)) {
    content = content.map((part) => part?.text || '').join('');
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

async function postChat({ baseUrl, token, model, prompt, includeResponseFormat, fetchImpl }) {
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

async function postMessages({ baseUrl, token, model, prompt, fetchImpl }) {
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
}) {
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

export async function companyAIReachable(baseUrl, fetchImpl = fetch) {
  try {
    const response = await fetchImpl(`${String(baseUrl).replace(/\/+$/, '')}/`, {
      signal: AbortSignal.timeout(5_000),
    });
    return response.ok;
  } catch {
    return false;
  }
}
