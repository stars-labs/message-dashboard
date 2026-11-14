// Shared dismiss behaviour for panels, sheets and dialogs.
//
// Before this, two of nine overlays closed on Escape and none moved focus when
// it opened, so a keyboard user tabbed through the page behind a full-screen
// drawer — while three of them claimed `aria-modal="true"`.
//
// Used as a Svelte action:
//   <div use:overlay={{ onClose: () => (open = false) }}>
//
// The node is made programmatically focusable (`tabindex="-1"`) rather than
// focusing the first control inside it: landing on a destructive button is
// worse than landing on the container, and a screen reader reads the dialog's
// label from the container anyway.

interface OverlayOptions {
  onClose?: (() => void) | null;
  autofocus?: boolean;
}

export function overlay(node: HTMLElement, options: OverlayOptions = {}) {
  let onClose: (() => void) | null = options.onClose ?? null;
  let autofocus = options.autofocus ?? true;
  const previouslyFocused = document.activeElement;

  function onKeydown(event: KeyboardEvent) {
    if (event.key !== 'Escape' || event.defaultPrevented) return;
    event.stopPropagation();
    onClose?.();
  }

  if (autofocus) {
    if (!node.hasAttribute('tabindex')) node.setAttribute('tabindex', '-1');
    // After the browser has painted, so the element is focusable.
    requestAnimationFrame(() => node.focus?.({ preventScroll: true }));
  }
  // Capture phase: a nested overlay still wins because its handler runs on the
  // inner node first and stops propagation.
  document.addEventListener('keydown', onKeydown);

  return {
    update(next: OverlayOptions = {}) {
      onClose = next.onClose ?? null;
      autofocus = next.autofocus ?? true;
    },
    destroy() {
      document.removeEventListener('keydown', onKeydown);
      // Give focus back to whatever opened the overlay, if it is still there.
      if (previouslyFocused instanceof HTMLElement && document.contains(previouslyFocused)) {
        previouslyFocused.focus?.({ preventScroll: true });
      }
    },
  };
}
