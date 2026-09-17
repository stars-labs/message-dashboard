import { cleanup, fireEvent, render } from '@testing-library/svelte';
import { afterEach, describe, expect, test } from 'bun:test';
import ConfirmHost from './ConfirmHost.svelte';
import { confirmAction } from './confirm.svelte.js';

afterEach(cleanup);

describe('shared confirmation dialog', () => {
  test('confirming resolves true, cancelling resolves false', async () => {
    const view = render(ConfirmHost);

    const first = confirmAction({ message: '删除这条规则？', confirmLabel: '删除', danger: true });
    await Promise.resolve();
    expect(view.getByText('删除这条规则？')).toBeTruthy();
    await fireEvent.click(view.getByText('删除'));
    expect(await first).toBe(true);

    const second = confirmAction({ message: '再来一次？' });
    await Promise.resolve();
    await fireEvent.click(view.getByText('取消'));
    expect(await second).toBe(false);
  });

  test('a second request answers the first with no', async () => {
    render(ConfirmHost);

    const first = confirmAction({ message: '第一个' });
    const second = confirmAction({ message: '第二个' });

    expect(await first).toBe(false);
    second.then(() => {});
  });

  test('without a host it falls back to the native dialog', async () => {
    const original = globalThis.confirm;
    const asked = [];
    globalThis.confirm = (message) => {
      asked.push(message);
      return true;
    };

    const answer = await confirmAction({ message: '没有宿主' });

    expect(answer).toBe(true);
    expect(asked).toEqual(['没有宿主']);
    globalThis.confirm = original;
  });
});
