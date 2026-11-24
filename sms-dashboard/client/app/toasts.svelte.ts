export type ToastType = 'success' | 'error' | 'info';

interface ToastItem {
  id: number;
  message: string;
  type: ToastType;
  duration: number;
}

export class ToastQueue {
  items = $state<ToastItem[]>([]);
  private sequence = 0;

  // Not Date.now(): same-millisecond toasts would share a key.
  show = (message: string, type: ToastType = 'info', duration = 4000) => {
    this.sequence += 1;
    this.items.push({ id: this.sequence, message, type, duration });
  };

  remove = (id: number) => {
    this.items = this.items.filter((t) => t.id !== id);
  };
}
