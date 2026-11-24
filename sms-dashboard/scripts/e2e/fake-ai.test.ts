import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import * as v from 'valibot';
import { startFakeAI, type FakeAI } from './fake-ai.ts';

const MessagesAnswer = v.object({
  content: v.tuple([v.object({ type: v.literal('text'), text: v.string() })]),
});
const ChatAnswer = v.object({
  choices: v.tuple([v.object({ message: v.object({ content: v.string() }) })]),
});

let ai: FakeAI;

beforeEach(() => {
  ai = startFakeAI();
});

afterEach(async () => {
  await ai.stop();
});

function messages(key: string | null, user: string): Promise<Response> {
  return fetch(`${ai.baseUrl}/v1/messages`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'anthropic-version': '2023-06-01',
      ...(key === null ? {} : { 'x-api-key': key }),
    },
    body: JSON.stringify({ model: 'm', system: 's', messages: [{ role: 'user', content: user }] }),
  });
}

async function messagesText(user: string): Promise<string> {
  const response = await messages(ai.token, user);
  expect(response.status).toBe(200);
  return v.parse(MessagesAnswer, await response.json()).content[0].text;
}

describe('fake company AI', () => {
  test('looks reachable to an unauthenticated probe without answering it', async () => {
    const response = await fetch(`${ai.baseUrl}/v1/messages`, { method: 'POST', body: '{}' });
    expect(response.status).toBe(401);
    expect(ai.prompts).toEqual([]);
  });

  test('answers only the two model routes', async () => {
    expect((await fetch(`${ai.baseUrl}/v1/models`)).status).toBe(404);
    expect((await fetch(`${ai.baseUrl}/v1/messages`)).status).toBe(404);
  });

  test('refuses a token it was not given', async () => {
    expect((await messages('wrong', 'hi')).status).toBe(401);
    const chat = await fetch(`${ai.baseUrl}/v1/chat/completions`, {
      method: 'POST',
      headers: { Authorization: 'Bearer wrong', 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: 'm', messages: [{ role: 'user', content: 'hi' }] }),
    });
    expect(chat.status).toBe(401);
    expect(ai.prompts).toEqual([]);
  });

  test('answers queued decisions in order, then the connection-check answer', async () => {
    ai.answer({ action: 'select', selected_option: '1' });
    ai.answer({ action: 'stop' });
    expect(JSON.parse(await messagesText('menu one'))).toEqual({
      action: 'select',
      selected_option: '1',
    });
    expect(JSON.parse(await messagesText('menu two'))).toEqual({ action: 'stop' });
    expect(JSON.parse(await messagesText('check'))).toEqual({ status: 'ok' });
    expect(ai.prompts).toEqual(['menu one', 'menu two', 'check']);
  });

  test('speaks the chat-completions format with a Bearer token', async () => {
    ai.answer({ action: 'stop' });
    const response = await fetch(`${ai.baseUrl}/v1/chat/completions`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${ai.token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: 'm',
        messages: [
          { role: 'system', content: 's' },
          { role: 'user', content: 'menu' },
        ],
      }),
    });
    expect(response.status).toBe(200);
    const content = v.parse(ChatAnswer, await response.json()).choices[0].message.content;
    expect(JSON.parse(content)).toEqual({ action: 'stop' });
    expect(ai.prompts).toEqual(['menu']);
  });
});
