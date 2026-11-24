export const DEFAULT_KEYWORD_COLOR = '#3B82F6';

// Hex only: the colour reaches a `--kw-color` CSS custom property on every client, so
// named colours and functional notation such as `url(...)` are refused.
const HEX_COLOR = /^#(?:[0-9A-Fa-f]{3,4}|[0-9A-Fa-f]{6}|[0-9A-Fa-f]{8})$/;

type KeywordColorCheck = { ok: true; value: string } | { ok: false; reason: string };

/** An absent colour yields the default; a malformed one is rejected, not replaced. */
export function normalizeKeywordColor(color: unknown): KeywordColorCheck {
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
