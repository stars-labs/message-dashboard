import { cleanup, render, waitFor } from '@testing-library/svelte';
import { afterEach, describe, expect, test, mock } from 'bun:test';
import SwUpdatePrompt from './SwUpdatePrompt.svelte';

const originalVisibility = Object.getOwnPropertyDescriptor(document, 'visibilityState');

afterEach(() => {
  cleanup();
  if (originalVisibility) {
    Object.defineProperty(document, 'visibilityState', originalVisibility);
  }
});

function registrationHarness({ waiting = null } = {}) {
  const registration = {
    waiting,
    update: mock(async () => {}),
  };
  const apply = mock(() => {});
  const registerServiceWorker = mock((options) => {
    options.onRegisteredSW('/sw.js', registration);
    return apply;
  });
  return { apply, registration, registerServiceWorker };
}

describe('SwUpdatePrompt', () => {
  test('exposes an explicit update check for pull-to-refresh', async () => {
    const harness = registrationHarness();
    const view = render(SwUpdatePrompt, {
      props: { registerServiceWorker: harness.registerServiceWorker },
    });

    await waitFor(() => {
      expect(typeof view.component.checkForUpdate).toBe('function');
    });
    await view.component.checkForUpdate();

    expect(harness.registration.update).toHaveBeenCalledTimes(1);
  });

  test('checks for a new version when the web app returns to the foreground', async () => {
    const harness = registrationHarness();
    render(SwUpdatePrompt, {
      props: { registerServiceWorker: harness.registerServiceWorker },
    });
    await waitFor(() => expect(harness.registerServiceWorker).toHaveBeenCalledTimes(1));

    Object.defineProperty(document, 'visibilityState', {
      configurable: true,
      value: 'visible',
    });
    document.dispatchEvent(new Event('visibilitychange'));

    await waitFor(() => expect(harness.registration.update).toHaveBeenCalledTimes(1));
  });

  test('describes a waiting build as ready and reloads it explicitly', async () => {
    const harness = registrationHarness({ waiting: {} });
    const view = render(SwUpdatePrompt, {
      props: { registerServiceWorker: harness.registerServiceWorker },
    });

    expect(await view.findByText('新版本已准备好')).toBeTruthy();
    await view.getByRole('button', { name: '重新载入' }).click();

    expect(harness.apply).toHaveBeenCalledWith(true);
  });
});
