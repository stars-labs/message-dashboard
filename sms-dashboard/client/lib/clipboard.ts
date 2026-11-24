// Returns false when the Clipboard API is unavailable or permission is denied (for example
// in an iframe without clipboard-write).
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
