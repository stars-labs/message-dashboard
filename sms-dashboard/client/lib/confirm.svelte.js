// One confirmation dialog for the whole app.
//
// Destructive actions used the native `confirm()`, which renders OS chrome with
// English OK/Cancel buttons in an otherwise Chinese UI, and looks foreign on a
// phone. Call sites stay one-liners:
//
//   if (!(await confirmAction({ message: '…', confirmLabel: '删除', danger: true }))) return;
//
// If no host is mounted — a component rendered alone in a unit test — this falls
// back to the native dialog rather than hanging on a promise nobody can resolve.

let pending = $state(null);
let hosted = false;

export function confirmState() {
  return pending;
}

/** Called by ConfirmHost while it is mounted. */
export function registerConfirmHost() {
  hosted = true;
  return () => {
    hosted = false;
    pending?.resolve(false);
    pending = null;
  };
}

/**
 * @param {{message: string, title?: string, confirmLabel?: string, cancelLabel?: string, danger?: boolean}} options
 * @returns {Promise<boolean>}
 */
export function confirmAction(options) {
  const { message, title = '请确认', confirmLabel = '确认', cancelLabel = '取消', danger = false } = options;
  if (!hosted) {
    return Promise.resolve(globalThis.confirm?.(message) ?? false);
  }
  // A second request while one is open answers the first with "no": two
  // destructive prompts stacked on each other is never what the operator meant.
  pending?.resolve(false);
  return new Promise((resolve) => {
    pending = {
      message,
      title,
      confirmLabel,
      cancelLabel,
      danger,
      resolve: (answer) => {
        pending = null;
        resolve(answer);
      },
    };
  });
}
