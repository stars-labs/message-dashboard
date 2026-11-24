// With no host mounted (a component rendered alone in a test) this falls back to the
// native dialog instead of hanging on a promise nobody can resolve.

interface ConfirmOptions {
  message: string;
  title?: string;
  confirmLabel?: string;
  cancelLabel?: string;
  danger?: boolean;
}

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
    return Promise.resolve('confirm' in globalThis ? globalThis.confirm(message) : false);
  }
  // A second request answers the open one with "no" rather than stacking destructive prompts.
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
