// Slices attacker-controlled SMS text: a bug here garbles messages or creates an XSS sink.

export const DEFAULT_KEYWORD_COLOR = '#3B82F6';

// Mirrors shared/keyword-color.ts, duplicated on purpose: the client must not trust server
// validation for a value it puts in a style attribute, and older rows may hold anything.
const HEX_COLOR = /^#(?:[0-9A-Fa-f]{3,4}|[0-9A-Fa-f]{6}|[0-9A-Fa-f]{8})$/;

export interface HighlightKeyword {
  keyword?: string | null;
  color?: string | null;
  tag?: string | null;
  case_sensitive?: boolean | number | null;
  whole_word?: boolean | number | null;
}

interface HighlightSegment {
  text: string;
  match: { color: string; tag: string | null } | null;
}

// Anything that is not a plain hex literal becomes the default, so it is safe in a CSS custom property.
export function safeColor(color: unknown): string {
  return typeof color === 'string' && HEX_COLOR.test(color.trim())
    ? color.trim()
    : DEFAULT_KEYWORD_COLOR;
}

// Returns null when there is nothing to highlight. The segments' `text` concatenates to
// `text.trim()` exactly: a partition, never a transformation.
export function getSegments(
  text: string | null | undefined,
  kws: readonly HighlightKeyword[] | null | undefined,
): HighlightSegment[] | null {
  if (!text || !kws || kws.length === 0) return null;

  const trimmed = text.trim();
  const matches: { position: number; text: string; color: string | null; tag: string | null }[] =
    [];

  for (const kw of kws) {
    if (!kw.keyword) continue;
    const searchText = kw.case_sensitive ? trimmed : trimmed.toLowerCase();
    const searchKw = kw.case_sensitive ? kw.keyword : kw.keyword.toLowerCase();
    if (searchKw.length === 0) continue;

    if (kw.whole_word) {
      const regex = new RegExp(
        `\\b${searchKw.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`,
        kw.case_sensitive ? 'g' : 'gi',
      );
      // matchAll advances past zero-length matches itself, unlike a manual lastIndex loop.
      for (const m of trimmed.matchAll(regex)) {
        matches.push({
          position: m.index,
          text: m[0],
          color: kw.color ?? null,
          tag: kw.tag ?? null,
        });
      }
    } else {
      let pos = 0;
      while ((pos = searchText.indexOf(searchKw, pos)) !== -1) {
        matches.push({
          position: pos,
          text: trimmed.slice(pos, pos + kw.keyword.length),
          color: kw.color ?? null,
          tag: kw.tag ?? null,
        });
        pos += kw.keyword.length;
      }
    }
  }

  if (matches.length === 0) return null;

  // Stable sort: ties keep kws order, where earlier means higher priority.
  matches.sort((a, b) => a.position - b.position);

  const filtered: typeof matches = [];
  let lastEnd = -1;
  for (const m of matches) {
    if (m.position >= lastEnd) {
      filtered.push(m);
      lastEnd = m.position + m.text.length;
    }
  }

  const segments: HighlightSegment[] = [];
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
