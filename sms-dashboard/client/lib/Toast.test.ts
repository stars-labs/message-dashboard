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
    for (const [type, icon, colour] of [
      ['success', '✓', 'bg-emerald-50'],
      ['error', '✕', 'bg-red-50'],
      ['info', 'ℹ', 'bg-blue-50'],
    ] as const) {
      const { container } = render(Toast, { props: { message: 'saved', type } });
      expect(container.textContent).toContain(icon);
      expect(container.innerHTML).toContain(colour);
      cleanup();
    }
  });

  test('is an info toast when no type is given', () => {
    const { container } = render(Toast, { props: { message: 'hm' } });
    expect(container.textContent).toContain('ℹ');
    cleanup();
  });

  // `duration: 0` disables auto-dismiss so this asserts the click path alone.
  test('invokes onClose after the dismiss button is clicked', async () => {
    let closed = false;
    const { getByRole } = render(Toast, {
      props: {
        message: 'bye',
        duration: 0,
        onClose: () => {
          closed = true;
        },
      },
    });

    getByRole('button').click();
    // dismiss() defers onClose by 200ms for the exit animation.
    await new Promise((resolve) => setTimeout(resolve, 260));

    expect(closed).toBe(true);
    cleanup();
  });

  test('closes itself after its duration', async () => {
    let closed = false;
    render(Toast, {
      props: {
        message: 'bye',
        duration: 20,
        onClose: () => {
          closed = true;
        },
      },
    });

    await new Promise((resolve) => setTimeout(resolve, 260));

    expect(closed).toBe(true);
    cleanup();
  });
});
