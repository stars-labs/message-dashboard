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

export interface ConfirmOptions {
  message: string;
  title?: string;
  confirmLabel?: string;
  cancelLabel?: string;
  danger?: boolean;
}

/** The request currently on screen, plus the resolver waiting for its answer. */
interface PendingConfirm {
  message: string;
  title: string;
  confirmLabel: string;
  cancelLabel: string;
  danger: boolean;
  resolve: (answer: boolean) => void;
}

let pending = $state<PendingConfirm | null>(null);
let hosted = false;

export function confirmState(): PendingConfirm | null {
  return pending;
}

/** Called by ConfirmHost while it is mounted. */
export function registerConfirmHost(): () => void {
  hosted = true;
  return () => {
    hosted = false;
    pending?.resolve(false);
    pending = null;
  };
}

export function confirmAction(options: ConfirmOptions): Promise<boolean> {
  const {
    message,
    title = '请确认',
    confirmLabel = '确认',
    cancelLabel = '取消',
    danger = false,
  } = options;
  if (!hosted) {
    return Promise.resolve(globalThis.confirm?.(message) ?? false);
  }
  // A second request while one is open answers the first with "no": two
  // destructive prompts stacked on each other is never what the operator meant.
  pending?.resolve(false);
  return new Promise<boolean>((resolve) => {
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
