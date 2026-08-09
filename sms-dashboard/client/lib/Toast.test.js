// Run with: bun test client/lib/Toast.test.js
//
// Smoke coverage for Toast. These tests exist to catch regressions during the
// Svelte 4 -> runes migration: they assert on rendered output and user-visible
// behaviour, never on which reactivity primitive is used internally, so the
// same tests must pass before and after the migration.
import { describe, expect, test } from 'bun:test';
import { render, cleanup } from '@testing-library/svelte';
import Toast from './Toast.svelte';

describe('Toast', () => {
  test('renders the message text', () => {
    const { getByText } = render(Toast, { props: { message: '已复制验证码' } });
    expect(getByText('已复制验证码')).toBeTruthy();
    cleanup();
  });

  test('picks the icon and colours matching the type', () => {
    const { container } = render(Toast, {
      props: { message: 'saved', type: 'success' },
    });
    expect(container.textContent).toContain('✓');
    expect(container.innerHTML).toContain('bg-emerald-50');
    cleanup();
  });

  test('falls back to the info style for an unknown type', () => {
    const { container } = render(Toast, {
      props: { message: 'hm', type: 'not-a-real-type' },
    });
    expect(container.textContent).toContain('ℹ');
    expect(container.innerHTML).toContain('bg-blue-50');
    cleanup();
  });

  // The close button is the one interactive element. `duration: 0` disables the
  // auto-dismiss timer so this asserts the click path alone.
  test('invokes onClose after the dismiss button is clicked', async () => {
    let closed = false;
    const { container } = render(Toast, {
      props: { message: 'bye', duration: 0, onClose: () => { closed = true; } },
    });

    container.querySelector('button').click();
    // dismiss() defers onClose by 200ms to let the exit animation run.
    await new Promise((resolve) => setTimeout(resolve, 260));

    expect(closed).toBe(true);
    cleanup();
  });
});
