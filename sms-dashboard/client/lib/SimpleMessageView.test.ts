import { afterEach, beforeEach, describe, expect, spyOn, test } from 'bun:test';
import { cleanup, fireEvent, render, waitFor } from '@testing-library/svelte';
import type { ApiMessage } from '../../shared/api/messages.js';
import type { Phone } from '../../shared/api/phones.js';
import SimpleMessageView from './SimpleMessageView.svelte';

interface SelectedPhone extends Pick<Phone, 'iccid' | 'sim_index' | 'number'> {
  flag: string;
}

const originalMatchMedia = Object.getOwnPropertyDescriptor(window, 'matchMedia');
let fetchSpy: ReturnType<typeof spyOn<typeof globalThis, 'fetch'>> | undefined;

function mediaQueryList(media: string): MediaQueryList {
  return Object.assign(new EventTarget(), {
    matches: false,
    media,
    onchange: null,
    addListener: () => undefined,
    removeListener: () => undefined,
  });
}

function stubKeywords(): void {
  fetchSpy = spyOn(globalThis, 'fetch').mockImplementation(
    Object.assign(() => Promise.resolve(Response.json({ keywords: [] })), {
      preconnect: () => undefined,
    }),
  );
}

function message(fields: Partial<ApiMessage> = {}): ApiMessage {
  return {
    id: 'message-1',
    phone_iccid: null,
    phone_number: null,
    content: 'hello',
    timestamp: '2026-08-26T00:00:00.000Z',
    type: 'received',
    status: null,
    recipient: null,
    verification_code: null,
    created_at: null,
    updated_at: null,
    error_message: null,
    sms_id: null,
    filter_status: 'clean',
    filter_rule_id: null,
    purpose: 'user',
    balance_check_id: null,
    processing_session_id: null,
    display_phone_number: null,
    phone_carrier: null,
    phone_status: null,
    phone_sim_index: null,
    phone_country: null,
    mapped_number: null,
    ...fields,
  };
}

beforeEach(() => {
  window.matchMedia = mediaQueryList;
});

afterEach(() => {
  cleanup();
  fetchSpy?.mockRestore();
  fetchSpy = undefined;
  if (originalMatchMedia) Object.defineProperty(window, 'matchMedia', originalMatchMedia);
});

describe('SimpleMessageView message direction', () => {
  test('shows the recipient for sent messages and the sender for received messages', async () => {
    stubKeywords();

    const selectedPhone: SelectedPhone = {
      iccid: '8986012345678901234',
      number: '+8617600419127',
      sim_index: 1,
      flag: '🇨🇳',
    };
    const view = render(SimpleMessageView, {
      props: {
        selectedPhone,
        messages: [
          message({
            id: 'sent-1',
            phone_iccid: selectedPhone.iccid,
            phone_number: selectedPhone.number,
            recipient: '10010',
            content: 'YE',
            timestamp: '2026-08-14T10:00:00.000Z',
            type: 'sent',
            status: 'failed',
            error_message: '+CMS ERROR: 350',
          }),
          message({
            id: 'received-1',
            phone_iccid: selectedPhone.iccid,
            phone_number: '106807059301423',
            content: '验证码 345030',
            verification_code: '345030',
            timestamp: '2026-08-14T09:00:00.000Z',
            type: 'received',
          }),
        ],
      },
    });

    await fireEvent.click(view.getByRole('button', { name: '全部短信' }));

    await waitFor(() => {
      expect(view.getAllByText('10010')).toHaveLength(1);
      expect(view.getAllByText('发送')).toHaveLength(1);
      expect(view.getAllByText('106807059301423')).toHaveLength(1);
      expect(view.getAllByText('接收')).toHaveLength(1);
      expect(view.getAllByText('发送失败')).toHaveLength(1);
    });

    expect(view.getAllByLabelText('发送失败：+CMS ERROR: 350')).toHaveLength(1);
  });
});

describe('SimpleMessageView render budget', () => {
  test('offers filtered-message auditing without an exact history count', async () => {
    stubKeywords();
    let toggles = 0;
    const view = render(SimpleMessageView, {
      props: {
        onToggleFiltered: () => {
          toggles += 1;
        },
      },
    });

    await fireEvent.click(view.getByRole('button', { name: '显示垃圾短信' }));
    expect(toggles).toBe(1);
  });

  test('creates only the first 60 message rows, then reveals the next batch', async () => {
    stubKeywords();
    const messages = Array.from({ length: 150 }, (_, index) =>
      message({
        id: `message-${index}`,
        phone_number: `sender-${index}`,
        content: `message body ${index}`,
        timestamp: new Date(Date.UTC(2026, 7, 26, 0, 0, 150 - index)).toISOString(),
        type: 'received',
      }),
    );

    const view = render(SimpleMessageView, { props: { messages } });

    expect(view.container.querySelectorAll('[data-message-row]')).toHaveLength(60);
    await fireEvent.click(view.getByRole('button', { name: '显示更多记录' }));
    expect(view.container.querySelectorAll('[data-message-row]')).toHaveLength(120);
  });

  test('renders one responsive row tree instead of separate mobile and desktop copies', () => {
    stubKeywords();
    const view = render(SimpleMessageView, {
      props: {
        messages: [
          message({
            id: 'only-one-tree',
            phone_number: '10086',
            content: 'hello',
            timestamp: '2026-08-26T00:00:00.000Z',
            type: 'received',
          }),
        ],
      },
    });

    const row = view.container.querySelector('[data-message-layout="responsive"]');
    if (!row) throw new Error('no message row rendered');
    expect(view.container.querySelectorAll('[data-message-row]')).toHaveLength(1);
    expect(row.className).toContain('grid-cols-[auto_minmax(0,1fr)_auto]');
    expect(row.className).toContain('lg:grid-cols-[3px_250px_118px_minmax(0,1fr)_92px]');
  });

  test('requests the next server page after the local batch is exhausted', async () => {
    stubKeywords();
    let loads = 0;
    const messages = Array.from({ length: 60 }, (_, index) =>
      message({
        id: `page-one-${index}`,
        phone_number: `sender-${index}`,
        content: `message ${index}`,
        timestamp: new Date(Date.UTC(2026, 7, 26, 0, 0, 60 - index)).toISOString(),
        type: 'received',
      }),
    );
    const view = render(SimpleMessageView, {
      props: {
        messages,
        hasMore: true,
        onLoadMore: () => {
          loads += 1;
          return Promise.resolve();
        },
      },
    });

    await fireEvent.click(view.getByRole('button', { name: '显示更多记录' }));
    expect(loads).toBe(1);
  });
});

describe('SimpleMessageView row activation', () => {
  const selectedPhone: SelectedPhone = {
    iccid: '8986012345678901234',
    number: '+8617600419127',
    sim_index: 1,
    flag: '🇨🇳',
  };

  const received = message({
    id: 'received-open',
    phone_iccid: selectedPhone.iccid,
    phone_number: '100860011575',
    content: '【心级服务 让爱连接】尊敬的客户，感谢您长期以来的支持。',
    verification_code: '345030',
    timestamp: '2026-08-14T09:00:00.000Z',
    type: 'received',
  });

  function renderList(onOpenMessage: (opened: ApiMessage) => void) {
    stubKeywords();
    return render(SimpleMessageView, {
      props: { selectedPhone, messages: [received], onOpenMessage },
    });
  }

  function firstRow(view: ReturnType<typeof renderList>): HTMLElement {
    const [row] = view
      .getAllByRole('button')
      .filter((el) => el.tagName === 'DIV' && el.textContent.includes('100860011575'));
    if (!row) throw new Error('no message row rendered');
    return row;
  }

  test('opens the detail drawer when a row is clicked', async () => {
    const opened: ApiMessage[] = [];
    const view = renderList((m) => {
      opened.push(m);
    });

    await fireEvent.click(firstRow(view));
    expect(opened[0]).toBe(received);
  });

  test('opens the detail drawer on Enter for keyboard users', async () => {
    const opened: ApiMessage[] = [];
    const view = renderList((m) => {
      opened.push(m);
    });

    await fireEvent.keyDown(firstRow(view), { key: 'Enter' });
    expect(opened[0]).toBe(received);
  });

  // Regression guard: the row opens the drawer, so the copy chip must stop the
  // click from bubbling. Without stopPropagation, tapping a code both copies AND
  // opens the drawer, which makes the primary interaction of the app feel broken.
  test('copying a verification code does NOT open the drawer', async () => {
    const opened: ApiMessage[] = [];
    const view = renderList((m) => {
      opened.push(m);
    });

    const [codeButton] = view
      .getAllByRole('button')
      .filter((el) => el.tagName === 'BUTTON' && el.textContent.trim() === '345030');
    if (!codeButton) throw new Error('no code button rendered');

    await fireEvent.click(codeButton);
    expect(opened).toHaveLength(0);
  });
});
