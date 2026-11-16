// Clipboard helper for the verification-code click-to-copy interaction.
//
// Deliberately NOT a Svelte action that mutates DOM directly: mutations from
// an action run outside Svelte's render cycle, leak event listeners on each
// `update()` call, and make the visual feedback harder to test. Instead this
// returns a plain Promise and lets component state drive the visual change.

/**
 * Copy `text` to the clipboard.
 * Returns true on success, false if the Clipboard API is unavailable or the
 * user denies permission (e.g. inside an iframe without clipboard-write).
 */
export async function copyCode(text: string): Promise<boolean> {
  // navigator.clipboard is exposed only in a secure context, though the DOM
  // types declare it unconditionally.
  if (!('clipboard' in navigator)) return false;
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    return false;
  }
}
