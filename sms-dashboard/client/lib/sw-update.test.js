import { describe, expect, it, mock } from 'bun:test';
import { createUpdateState, dismiss, needRefresh, applyUpdate, registerError } from './sw-update.js';

describe('createUpdateState', () => {
  it('starts with nothing to show', () => {
    const s = createUpdateState();
    expect(s.available).toBe(false);
    expect(s.applying).toBe(false);
  });
});

describe('needRefresh', () => {
  it('marks an update available', () => {
    const s = createUpdateState();
    needRefresh(s);
    expect(s.available).toBe(true);
  });

  it('is idempotent — a second waiting worker does not stack prompts', () => {
    const s = createUpdateState();
    needRefresh(s);
    needRefresh(s);
    expect(s.available).toBe(true);
  });

  it('does not resurrect the prompt while an update is already applying', () => {
    // The new worker activating can fire another update event. Re-showing the bar
    // mid-reload would flash a prompt the user already acted on.
    const s = createUpdateState();
    needRefresh(s);
    applyUpdate(s, () => {});
    needRefresh(s);
    expect(s.available).toBe(false);
  });
});

describe('dismiss', () => {
  it('hides the prompt without applying anything', () => {
    const s = createUpdateState();
    needRefresh(s);
    dismiss(s);
    expect(s.available).toBe(false);
    expect(s.applying).toBe(false);
  });

  it('leaves a later update free to prompt again', () => {
    const s = createUpdateState();
    needRefresh(s);
    dismiss(s);
    needRefresh(s);
    expect(s.available).toBe(true);
  });
});

describe('applyUpdate', () => {
  it('reloads via the supplied updater', () => {
    const s = createUpdateState();
    const updateSW = mock(() => {});
    needRefresh(s);
    applyUpdate(s, updateSW);
    expect(updateSW).toHaveBeenCalledTimes(1);
    // true = take over and reload the page.
    expect(updateSW).toHaveBeenCalledWith(true);
  });

  it('hides the prompt and marks itself applying', () => {
    const s = createUpdateState();
    needRefresh(s);
    applyUpdate(s, () => {});
    expect(s.available).toBe(false);
    expect(s.applying).toBe(true);
  });

  it('ignores a double tap — reload must not fire twice', () => {
    const s = createUpdateState();
    const updateSW = mock(() => {});
    needRefresh(s);
    applyUpdate(s, updateSW);
    applyUpdate(s, updateSW);
    expect(updateSW).toHaveBeenCalledTimes(1);
  });

  it('does nothing when no update is available', () => {
    const s = createUpdateState();
    const updateSW = mock(() => {});
    applyUpdate(s, updateSW);
    expect(updateSW).not.toHaveBeenCalled();
    expect(s.applying).toBe(false);
  });

  it('tolerates a missing updater rather than throwing mid-click', () => {
    const s = createUpdateState();
    needRefresh(s);
    expect(() => applyUpdate(s, null)).not.toThrow();
    expect(s.available).toBe(false);
  });
});

describe('registerError', () => {
  it('never surfaces a prompt — a failed registration is not user-actionable', () => {
    const s = createUpdateState();
    registerError(s);
    expect(s.available).toBe(false);
    expect(s.applying).toBe(false);
  });
});
