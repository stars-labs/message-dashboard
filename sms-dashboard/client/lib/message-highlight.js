// Segment logic for MessageHighlight.svelte.
//
// Extracted from the component so it can be unit tested: this code slices
// attacker-controlled SMS text, and a bug here either garbles a displayed message or
// (previously) produced an XSS sink. See docs/SECURITY-REVIEW.md finding 2.

export const DEFAULT_KEYWORD_COLOR = '#3B82F6';

// Mirrors server/utils/keyword-color.js. Duplicated deliberately rather than imported:
// the client must not trust the server's validation for a value it puts in a style
// attribute, and rows written before that validation existed may hold anything.
const HEX_COLOR = /^#(?:[0-9A-Fa-f]{3,4}|[0-9A-Fa-f]{6}|[0-9A-Fa-f]{8})$/;

/**
 * Coerce a stored keyword colour to something safe for a CSS custom property.
 * Anything that is not a plain hex literal becomes the default.
 */
export function safeColor(color) {
  return typeof color === 'string' && HEX_COLOR.test(color.trim())
    ? color.trim()
    : DEFAULT_KEYWORD_COLOR;
}

/**
 * Split `text` into consecutive segments, marking keyword matches.
 *
 * @returns {Array<{text: string, match: {color: string, tag: string}|null}>|null}
 *   null when there is nothing to highlight, so the caller can render the raw string.
 *
 * Concatenating every segment's `text` always reproduces `text.trim()` exactly — the
 * segments are a partition, never a transformation.
 */
export function getSegments(text, kws) {
  if (!text || !kws || kws.length === 0) return null;

  const trimmed = text.trim();
  const matches = [];

  for (const kw of kws) {
    if (!kw.keyword) continue;
    const searchText = kw.case_sensitive ? trimmed : trimmed.toLowerCase();
    const searchKw = kw.case_sensitive ? kw.keyword : kw.keyword.toLowerCase();
    if (searchKw.length === 0) continue;

    if (kw.whole_word) {
      const regex = new RegExp(
        `\\b${searchKw.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`,
        kw.case_sensitive ? 'g' : 'gi'
      );
      // matchAll advances past zero-length matches on its own, so a pathological
      // keyword cannot spin here the way a manual lastIndex loop could.
      for (const m of trimmed.matchAll(regex)) {
        matches.push({ position: m.index, text: m[0], color: kw.color, tag: kw.tag });
      }
    } else {
      let pos = 0;
      while ((pos = searchText.indexOf(searchKw, pos)) !== -1) {
        matches.push({
          position: pos,
          text: trimmed.substr(pos, kw.keyword.length),
          color: kw.color,
          tag: kw.tag,
        });
        pos += kw.keyword.length;
      }
    }
  }

  if (matches.length === 0) return null;

  // Sort by position, then priority (earlier in kws array = higher priority)
  matches.sort((a, b) => a.position - b.position);

  // Remove overlaps (keep first match at each position)
  const filtered = [];
  let lastEnd = -1;
  for (const m of matches) {
    if (m.position >= lastEnd) {
      filtered.push(m);
      lastEnd = m.position + m.text.length;
    }
  }

  const segments = [];
  let lastPos = 0;
  for (const m of filtered) {
    if (m.position > lastPos) {
      segments.push({ text: trimmed.substring(lastPos, m.position), match: null });
    }
    segments.push({ text: m.text, match: { color: safeColor(m.color), tag: m.tag } });
    lastPos = m.position + m.text.length;
  }
  if (lastPos < trimmed.length) {
    segments.push({ text: trimmed.substring(lastPos), match: null });
  }

  return segments;
}
