<script>
  export let content = '';
  export let keywords = [];

  // Find all keyword matches in content, apply highlights via HTML spans
  function getHighlightedHtml(text, kws) {
    if (!text || !kws || kws.length === 0) return null;

    const trimmed = text.trim();
    const matches = [];

    for (const kw of kws) {
      if (!kw.keyword) continue;
      const searchText = kw.case_sensitive ? trimmed : trimmed.toLowerCase();
      const searchKw = kw.case_sensitive ? kw.keyword : kw.keyword.toLowerCase();

      if (kw.whole_word) {
        const regex = new RegExp(
          `\\b${searchKw.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`,
          kw.case_sensitive ? 'g' : 'gi'
        );
        let m;
        while ((m = regex.exec(trimmed)) !== null) {
          matches.push({ position: m.index, text: m[0], color: kw.color || '#3B82F6', tag: kw.tag });
        }
      } else {
        let pos = 0;
        while ((pos = searchText.indexOf(searchKw, pos)) !== -1) {
          matches.push({ position: pos, text: trimmed.substr(pos, kw.keyword.length), color: kw.color || '#3B82F6', tag: kw.tag });
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

    // Build HTML
    let result = '';
    let lastPos = 0;
    for (const m of filtered) {
      result += escapeHtml(trimmed.substring(lastPos, m.position));
      result += `<mark class="kw-hl" style="--kw-color: ${m.color}" title="${escapeHtml(m.tag)}">${escapeHtml(m.text)}</mark>`;
      lastPos = m.position + m.text.length;
    }
    result += escapeHtml(trimmed.substring(lastPos));
    return result;
  }

  function escapeHtml(text) {
    return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  }

  $: highlighted = getHighlightedHtml(content, keywords);
</script>

{#if highlighted}
  <span class="break-words">{@html highlighted}</span>
{:else}
  <span class="break-words">{content}</span>
{/if}

<style>
  :global(.kw-hl) {
    background: color-mix(in srgb, var(--kw-color, #3B82F6) 15%, transparent);
    border-bottom: 2px solid var(--kw-color, #3B82F6);
    color: inherit;
    padding: 0 1px;
    border-radius: 2px;
    font-weight: 600;
  }
</style>
