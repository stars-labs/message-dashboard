import { describe, expect, test } from 'bun:test';
import { fireEvent, cleanup, render, waitFor } from '@testing-library/svelte';
import { tick } from 'svelte';
import MessageComposer from './MessageComposer.svelte';

describe('MessageComposer mobile route', () => {
  test('renders as normal route content when enabled', () => {
    const { container } = render(MessageComposer, {
      props: {
        mobilePage: true,
      },
    });

    const page = container.querySelector('[data-mobile-composer]');
    expect(page).toBeTruthy();
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
    const phone = {
      iccid: '8986000000000000001',
      number: '+6512345678',
      status: 'active',
    };
    const { container } = render(MessageComposer, {
      props: {
        mobilePage: true,
        selectedPhone: phone,
        phoneNumbers: [phone],
        onmessagesent: async () => {
          throw new Error('network unavailable');
        },
      },
    });

    await tick();
    const page = container.querySelector('[data-mobile-composer]');
    const recipient = page.querySelector('#mobile-recipient-number');
    const content = page.querySelector('#mobile-message-content');
    const sendButton = [...page.querySelectorAll('button')]
      .find((button) => button.textContent.trim() === '发送短信');

    await fireEvent.input(recipient, { target: { value: '81234567' } });
    await fireEvent.input(content, { target: { value: 'retry this message' } });
    await fireEvent.click(sendButton);

    await waitFor(() => {
      expect(sendButton.textContent).toContain('发送失败，请重试');
    });
    expect(content.value).toBe('retry this message');
    cleanup();
  });

  test('sends a carrier short code unchanged when no country code is selected', async () => {
    sessionStorage.clear();
    let submitted;
    const phone = {
      iccid: '89860117811049221139',
      number: '+8617600419127',
      status: 'active',
    };
    const view = render(MessageComposer, {
      props: {
        mobilePage: true,
        selectedPhone: phone,
        phoneNumbers: [phone],
        onmessagesent: async (message) => { submitted = message; },
      },
    });

    await tick();
    const page = view.container.querySelector('[data-mobile-composer]');
    const countrySelector = page.querySelector('.country-code-container > button');
    await fireEvent.click(countrySelector);
    const noCountryCode = [...page.querySelectorAll('.country-code-container button')]
      .find((button) => button.textContent.includes('不加区号'));
    await fireEvent.click(noCountryCode);
    await fireEvent.input(page.querySelector('#mobile-recipient-number'), {
      target: { value: '10010' },
    });
    await fireEvent.input(page.querySelector('#mobile-message-content'), {
      target: { value: 'YE' },
    });
    await fireEvent.click([...page.querySelectorAll('button')]
      .find((button) => button.textContent.trim() === '发送短信'));

    await waitFor(() => expect(submitted?.recipient).toBe('10010'));
    cleanup();
  });
});
