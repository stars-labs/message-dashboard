// Svelte action: <div use:overlay={{ onClose: () => (open = false) }}>
//
// The node itself takes focus (`tabindex="-1"`), not the first control inside: landing on a
// destructive button is worse, and screen readers read the dialog label from the container.

interface OverlayOptions {
  onClose?: (() => void) | null;
  autofocus?: boolean;
}

// Escape closes only the last one, so a dialog opened over a drawer closes alone.
const openOverlays: object[] = [];

export function overlay(node: HTMLElement, options: OverlayOptions = {}) {
  let onClose: (() => void) | null = options.onClose ?? null;
  let autofocus = options.autofocus ?? true;
  const previouslyFocused = document.activeElement;
  const self = {};
  openOverlays.push(self);

  function onKeydown(event: KeyboardEvent) {
    if (event.key !== 'Escape' || event.defaultPrevented) return;
    if (openOverlays.at(-1) !== self) return;
    event.stopPropagation();
    onClose?.();
  }

  if (autofocus) {
    if (!node.hasAttribute('tabindex')) node.setAttribute('tabindex', '-1');
    // Wait for paint so the element is focusable.
    requestAnimationFrame(() => {
      node.focus({ preventScroll: true });
    });
  }
  document.addEventListener('keydown', onKeydown);

  return {
    update(next: OverlayOptions = {}) {
      onClose = next.onClose ?? null;
      autofocus = next.autofocus ?? true;
    },
    destroy() {
      document.removeEventListener('keydown', onKeydown);
      const index = openOverlays.indexOf(self);
      if (index !== -1) openOverlays.splice(index, 1);
      if (previouslyFocused instanceof HTMLElement && document.contains(previouslyFocused)) {
        previouslyFocused.focus({ preventScroll: true });
      }
    },
  };
}
