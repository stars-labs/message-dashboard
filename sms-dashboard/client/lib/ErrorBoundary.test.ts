import { cleanup, fireEvent, render } from '@testing-library/svelte';
import { afterEach, beforeEach, describe, expect, spyOn, test } from 'bun:test';
import { tick } from 'svelte';
import ErrorBoundary from './ErrorBoundary.svelte';

let errorSpy: ReturnType<typeof spyOn<Console, 'error'>>;

beforeEach(() => {
  errorSpy = spyOn(console, 'error').mockImplementation(() => undefined);
});

afterEach(() => {
  errorSpy.mockRestore();
  cleanup();
});

function windowError(error: unknown, filename = 'https://sexy.itoken.world/assets/app.js') {
  const event = new ErrorEvent('error', {
    error,
    message: error instanceof Error ? error.message : '',
    filename,
    cancelable: true,
  });
  window.dispatchEvent(event);
  return event;
}

describe('ErrorBoundary', () => {
  test('replaces the page with the error and offers a retry', async () => {
    const view = render(ErrorBoundary, { props: { componentName: 'App' } });

    const event = windowError(new Error('数据加载失败'));
    await tick();

    expect(view.getByText('页面出错了')).toBeTruthy();
    expect(view.getByText('数据加载失败')).toBeTruthy();
    expect(event.defaultPrevented).toBe(true);

    await fireEvent.click(view.getByRole('button', { name: '重试' }));
    expect(view.queryByText('页面出错了')).toBeNull();
  });

  test('leaves an error thrown by a browser extension alone', async () => {
    const view = render(ErrorBoundary);

    const event = windowError(
      new Error('Failed to connect to MetaMask'),
      'chrome-extension://abc/inpage.js',
    );
    await tick();

    expect(view.queryByText('页面出错了')).toBeNull();
    expect(event.defaultPrevented).toBe(false);
  });

  test('shows an unhandled rejection from the app', async () => {
    const view = render(ErrorBoundary);

    const event = new Event('unhandledrejection', { cancelable: true });
    Object.defineProperty(event, 'reason', { value: new Error('请求失败') });
    window.dispatchEvent(event);
    await tick();

    expect(view.getByText('请求失败')).toBeTruthy();
  });
});
