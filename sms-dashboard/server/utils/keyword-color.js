// Validation for keyword highlight colours.
//
// The colour is stored per keyword and sent to every dashboard client, which applies it
// to a `--kw-color` CSS custom property on the <mark> wrapping each match. It was
// previously accepted unvalidated and interpolated raw into an HTML attribute inside a
// Svelte `{@html}` block, so a value like `red" onmouseover="fetch(...)` injected an
// event handler that ran in another operator's browser.
// See docs/SECURITY-REVIEW.md finding 2.
//
// The client no longer uses `{@html}`, so this is defence in depth — but it also stops
// arbitrary CSS reaching the custom property, which is a live sink in its own right
// (e.g. `url(...)` in a value that lands in a `background`).

export const DEFAULT_KEYWORD_COLOR = '#3B82F6';

// Hex only: #RGB, #RGBA, #RRGGBB, #RRGGBBAA. Named colours and functional notation
// (rgb()/hsl()/color-mix()) are deliberately not accepted — the UI is a colour picker
// that emits #RRGGBB, so anything else is either a mistake or an attempt.
const HEX_COLOR = /^#(?:[0-9A-Fa-f]{3,4}|[0-9A-Fa-f]{6}|[0-9A-Fa-f]{8})$/;

/**
 * Validate a keyword colour.
 *
 * @param {unknown} color
 * @returns {{ok: true, value: string} | {ok: false, reason: string}}
 *
 * An absent colour is valid and yields the default; an malformed one is rejected rather
 * than replaced, so a client sending garbage learns about it instead of silently
 * getting blue.
 */
export function normalizeKeywordColor(color) {
  if (color === undefined || color === null || color === '') {
    return { ok: true, value: DEFAULT_KEYWORD_COLOR };
  }

  if (typeof color !== 'string') {
    return { ok: false, reason: 'color must be a string' };
  }

  const value = color.trim();

  if (!HEX_COLOR.test(value)) {
    return {
      ok: false,
      reason: 'color must be a hex value such as #3B82F6 (3, 4, 6 or 8 hex digits)',
    };
  }

  return { ok: true, value };
}
