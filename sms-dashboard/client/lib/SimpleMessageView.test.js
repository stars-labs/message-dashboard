import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { cleanup, fireEvent, render, waitFor } from '@testing-library/svelte';
import SimpleMessageView from './SimpleMessageView.svelte';

const originalFetch = globalThis.fetch;
const originalMatchMedia = window.matchMedia;

beforeEach(() => {
  window.matchMedia = () => ({
    matches: false,
    addEventListener() {},
    removeEventListener() {},
  });
});

afterEach(() => {
  cleanup();
  globalThis.fetch = originalFetch;
  window.matchMedia = originalMatchMedia;
});

describe('SimpleMessageView message direction', () => {
  test('shows the recipient for sent messages and the sender for received messages', async () => {
    globalThis.fetch = async () => Response.json({ keywords: [] });

    const selectedPhone = {
      iccid: '8986012345678901234',
      number: '+8617600419127',
      sim_index: 1,
      flag: '🇨🇳',
    };
    const view = render(SimpleMessageView, {
      props: {
        selectedPhone,
        messages: [
          {
            id: 'sent-1',
            phone_iccid: selectedPhone.iccid,
            phone_number: selectedPhone.number,
            recipient: '10010',
            content: 'YE',
            timestamp: '2026-08-14T10:00:00.000Z',
            type: 'sent',
            status: 'failed',
            error_message: '+CMS ERROR: 350',
          },
          {
            id: 'received-1',
            phone_iccid: selectedPhone.iccid,
            phone_number: '106807059301423',
            content: '验证码 345030',
            verification_code: '345030',
            timestamp: '2026-08-14T09:00:00.000Z',
            type: 'received',
          },
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
  test('creates only the first 60 message rows, then reveals the next batch', async () => {
    globalThis.fetch = async () => Response.json({ keywords: [] });
    const messages = Array.from({ length: 150 }, (_, index) => ({
      id: `message-${index}`,
      phone_number: `sender-${index}`,
      content: `message body ${index}`,
      timestamp: new Date(Date.UTC(2026, 7, 26, 0, 0, 150 - index)).toISOString(),
      type: 'received',
    }));

    const view = render(SimpleMessageView, { props: { messages } });

    expect(view.container.querySelectorAll('[data-message-row]')).toHaveLength(60);
    await fireEvent.click(view.getByRole('button', { name: '显示更多记录' }));
    expect(view.container.querySelectorAll('[data-message-row]')).toHaveLength(120);
  });

  test('renders one responsive row tree instead of separate mobile and desktop copies', () => {
    globalThis.fetch = async () => Response.json({ keywords: [] });
    const view = render(SimpleMessageView, {
      props: {
        messages: [{
          id: 'only-one-tree',
          phone_number: '10086',
          content: 'hello',
          timestamp: '2026-08-26T00:00:00.000Z',
          type: 'received',
        }],
      },
    });

    const row = view.container.querySelector('[data-message-layout="responsive"]');
    expect(row).toBeTruthy();
    expect(view.container.querySelectorAll('[data-message-row]')).toHaveLength(1);
    expect(row.className).toContain('grid-cols-[auto_minmax(0,1fr)_auto]');
    expect(row.className).toContain('lg:grid-cols-[3px_250px_118px_minmax(0,1fr)_92px]');
  });

  test('requests the next server page after the local batch is exhausted', async () => {
    globalThis.fetch = async () => Response.json({ keywords: [] });
    let loads = 0;
    const messages = Array.from({ length: 60 }, (_, index) => ({
      id: `page-one-${index}`,
      phone_number: `sender-${index}`,
      content: `message ${index}`,
      timestamp: new Date(Date.UTC(2026, 7, 26, 0, 0, 60 - index)).toISOString(),
      type: 'received',
    }));
    const view = render(SimpleMessageView, {
      props: {
        messages,
        hasMore: true,
        onLoadMore: async () => { loads += 1; },
      },
    });

    await fireEvent.click(view.getByRole('button', { name: '显示更多记录' }));
    expect(loads).toBe(1);
  });
});

describe('SimpleMessageView row activation', () => {
  const selectedPhone = {
    iccid: '8986012345678901234',
    number: '+8617600419127',
    sim_index: 1,
    flag: '🇨🇳',
  };

  const message = {
    id: 'received-open',
    phone_iccid: selectedPhone.iccid,
    phone_number: '100860011575',
    content: '【心级服务 让爱连接】尊敬的客户，感谢您长期以来的支持。',
    verification_code: '345030',
    timestamp: '2026-08-14T09:00:00.000Z',
    type: 'received',
  };

  function renderList(onOpenMessage) {
    globalThis.fetch = async () => Response.json({ keywords: [] });
    return render(SimpleMessageView, {
      props: { selectedPhone, messages: [message], onOpenMessage },
    });
  }

  test('opens the detail drawer when a row is clicked', async () => {
    let opened = null;
    const view = renderList((m) => { opened = m; });

    const rows = view.getAllByRole('button').filter(
      (el) => el.tagName === 'DIV' && el.textContent.includes('100860011575')
    );
    expect(rows.length).toBeGreaterThan(0);

    await fireEvent.click(rows[0]);
    expect(opened).toBe(message);
  });

  test('opens the detail drawer on Enter for keyboard users', async () => {
    let opened = null;
    const view = renderList((m) => { opened = m; });

    const rows = view.getAllByRole('button').filter(
      (el) => el.tagName === 'DIV' && el.textContent.includes('100860011575')
    );
    await fireEvent.keyDown(rows[0], { key: 'Enter' });
    expect(opened).toBe(message);
  });

  // Regression guard: the row opens the drawer, so the copy chip must stop the
  // click from bubbling. Without stopPropagation, tapping a code both copies AND
  // opens the drawer, which makes the primary interaction of the app feel broken.
  test('copying a verification code does NOT open the drawer', async () => {
    let opened = null;
    const view = renderList((m) => { opened = m; });

    const codeButtons = view.getAllByRole('button').filter(
      (el) => el.tagName === 'BUTTON' && el.textContent.trim() === '345030'
    );
    expect(codeButtons.length).toBeGreaterThan(0);

    await fireEvent.click(codeButtons[0]);
    expect(opened).toBeNull();
  });
});
