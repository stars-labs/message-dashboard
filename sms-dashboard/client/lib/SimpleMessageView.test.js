import { afterEach, describe, expect, test } from 'bun:test';
import { cleanup, fireEvent, render, waitFor } from '@testing-library/svelte';
import SimpleMessageView from './SimpleMessageView.svelte';

const originalFetch = globalThis.fetch;

afterEach(() => {
  cleanup();
  globalThis.fetch = originalFetch;
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
      expect(view.getAllByText('10010')).toHaveLength(2);
      expect(view.getAllByText('发送')).toHaveLength(2);
      expect(view.getAllByText('106807059301423')).toHaveLength(2);
      expect(view.getAllByText('接收')).toHaveLength(2);
      expect(view.getAllByText('发送失败')).toHaveLength(2);
    });

    expect(view.getAllByLabelText('发送失败：+CMS ERROR: 350')).toHaveLength(2);
  });
});
