import { describe, expect, test } from 'bun:test';
import { cleanup, render } from '@testing-library/svelte';
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
});
