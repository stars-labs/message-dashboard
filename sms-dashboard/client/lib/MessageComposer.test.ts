import { cleanup, fireEvent, render, waitFor } from '@testing-library/svelte';
import { describe, expect, test } from 'bun:test';
import { tick } from 'svelte';
import type { Phone } from '../../shared/api/phones.js';
import MessageComposer from './MessageComposer.svelte';

interface SenderPhone extends Pick<
  Phone,
  'iccid' | 'number' | 'status' | 'carrier' | 'operator' | 'sim_index'
> {
  flag: string;
}

function senderPhone(fields: Pick<Phone, 'iccid' | 'number'>): SenderPhone {
  return {
    ...fields,
    status: 'active',
    carrier: null,
    operator: null,
    sim_index: 1,
    flag: '',
  };
}

function element<T extends HTMLElement>(
  container: ParentNode,
  selector: string,
  type: new () => T,
): T {
  const found = container.querySelector(selector);
  if (!(found instanceof type)) throw new Error(`no ${selector} rendered`);
  return found;
}

function sendButton(page: HTMLElement): HTMLElement {
  const found = [...page.querySelectorAll('button')].find(
    (button) => button.textContent.trim() === '发送短信',
  );
  if (!found) throw new Error('no send button rendered');
  return found;
}

describe('MessageComposer mobile route', () => {
  test('renders as normal route content when enabled', () => {
    const { container } = render(MessageComposer, {
      props: {
        mobilePage: true,
      },
    });

    const page = element(container, '[data-mobile-composer]', HTMLElement);
    expect(page.classList.contains('fixed')).toBe(false);
    expect(page.textContent).toContain('发送短信');
    cleanup();
  });

  test('does not render mobile route content for desktop instances', () => {
    const { container } = render(MessageComposer);
    expect(container.querySelector('[data-mobile-composer]')).toBeNull();
    cleanup();
  });

  test('keeps the draft and reports failure when the API rejects the send', async () => {
    sessionStorage.clear();
    const phone = senderPhone({ iccid: '8986000000000000001', number: '+6512345678' });
    const { container } = render(MessageComposer, {
      props: {
        mobilePage: true,
        selectedPhone: phone,
        phoneNumbers: [phone],
        onmessagesent: () => Promise.reject(new Error('network unavailable')),
      },
    });

    await tick();
    const page = element(container, '[data-mobile-composer]', HTMLElement);
    const recipient = element(page, '#mobile-recipient-number', HTMLInputElement);
    const content = element(page, '#mobile-message-content', HTMLTextAreaElement);
    const button = sendButton(page);

    await fireEvent.input(recipient, { target: { value: '81234567' } });
    await fireEvent.input(content, { target: { value: 'retry this message' } });
    await fireEvent.click(button);

    await waitFor(() => {
      // The copy must not invite a blind retry: a send that failed after the
      // Worker accepted it may already be on its way to a real handset.
      expect(button.textContent).toContain('提交失败，请先查看发送记录');
    });
    expect(content.value).toBe('retry this message');
    cleanup();
  });

  test('sends a carrier short code unchanged when no country code is selected', async () => {
    sessionStorage.clear();
    let recipientSent: string | undefined;
    const phone = senderPhone({ iccid: '89860117811049221139', number: '+8617600419127' });
    const view = render(MessageComposer, {
      props: {
        mobilePage: true,
        selectedPhone: phone,
        phoneNumbers: [phone],
        onmessagesent: (sent: { recipient: string }) => {
          recipientSent = sent.recipient;
          return Promise.resolve();
        },
      },
    });

    await tick();
    const page = element(view.container, '[data-mobile-composer]', HTMLElement);
    const countrySelector = element(page, '.country-code-container > button', HTMLElement);
    await fireEvent.click(countrySelector);
    const noCountryCode = [...page.querySelectorAll('.country-code-container button')].find(
      (button) => button.textContent.includes('不加区号'),
    );
    if (!noCountryCode) throw new Error('no country code option rendered');
    await fireEvent.click(noCountryCode);
    await fireEvent.input(element(page, '#mobile-recipient-number', HTMLInputElement), {
      target: { value: '10010' },
    });
    await fireEvent.input(element(page, '#mobile-message-content', HTMLTextAreaElement), {
      target: { value: 'YE' },
    });
    await fireEvent.click(sendButton(page));

    await waitFor(() => {
      expect(recipientSent).toBe('10010');
    });
    cleanup();
  });
});
