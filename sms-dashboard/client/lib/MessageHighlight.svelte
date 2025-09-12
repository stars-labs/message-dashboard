<script>
  import { onMount, afterUpdate } from 'svelte';
  import { api } from './api.js';
  import { applyHighlightEffects } from './webgpu-highlight-effects.js';
  
  export let content = '';
  export let messageId = null;
  export let onTagsExtracted = null;
  export let serverTags = null; // Pre-fetched tags from parent component
  export let preloadedKeywords = null; // Keywords loaded once by parent
  export let disableServerFetch = true; // Disable individual fetching by default
  
  let keywords = [];
  let messageTags = [];
  let highlightedContent = '';
  let loading = true;
  let extractedTags = [];
  let containerEl;
  
  // Trim content to remove leading/trailing whitespace - manual update to avoid circular deps
  let trimmedContent = '';
  
  // Manual function to update content and keywords
  function updateContent() {
    trimmedContent = content ? content.trim() : '';
    
    // Update keywords when preloadedKeywords changes
    if (preloadedKeywords !== null && preloadedKeywords !== undefined) {
      keywords = preloadedKeywords;
      // Re-process content when keywords change
      if (!serverTags || serverTags.length === 0) {
        highlightedContent = processContent(trimmedContent);
      }
    }
  }
  
  onMount(async () => {
    // Update content initially
    updateContent();
    
    // Use preloaded keywords if available
    if (preloadedKeywords !== null && preloadedKeywords !== undefined) {
      // If preloadedKeywords is provided (even if empty array), use it
      keywords = preloadedKeywords || [];
      console.debug('[MessageHighlight] Using preloaded keywords:', keywords.length);
    } else if (!disableServerFetch) {
      // Only load keywords if not in batch mode and server fetch is enabled
      console.warn('[MessageHighlight] Loading keywords individually - this should be avoided!');
      await loadKeywords();
    } else {
      // In batch mode with no keywords yet - use empty array
      keywords = [];
    }
    
    // Use pre-fetched tags if available
    if (serverTags && serverTags.length > 0) {
      messageTags = serverTags;
      highlightedContent = applyHighlights(trimmedContent, messageTags);
    } else if (messageId && !disableServerFetch) {
      // Only fetch individually if not disabled
      await loadMessageTags();
    } else {
      // Fall back to client-side highlighting
      highlightedContent = processContent(trimmedContent);
    }
    loading = false;
  });
  
  // Watch for prop changes manually to avoid reactive circular dependencies
  let lastContent = content;
  let lastPreloadedKeywords = preloadedKeywords;
  
  afterUpdate(() => {
    // Watch for prop changes manually to avoid reactive circular dependencies
    if (content !== lastContent || preloadedKeywords !== lastPreloadedKeywords) {
      lastContent = content;
      lastPreloadedKeywords = preloadedKeywords;
      updateContent();
    }
    
    // Apply custom colors to highlights after DOM update
    applyHighlightColors();
    // Apply WebGPU effects
    if (containerEl) {
      applyHighlightEffects(containerEl);
    }
  });
  
  function applyHighlightColors() {
    const highlights = document.querySelectorAll('.keyword-highlight-webgpu');
    highlights.forEach(el => {
      const color = el.getAttribute('data-color');
      if (color) {
        el.style.setProperty('--highlight-color', color);
        el.style.color = color;
      }
    });
  }
  
  async function loadKeywords() {
    try {
      const response = await api.get('/api/keywords');
      if (response.keywords) {
        // Only load active keywords, sorted by priority
        keywords = response.keywords
          .filter(k => k.is_active)
          .sort((a, b) => (b.priority || 0) - (a.priority || 0));
      }
    } catch (err) {
      console.error('[MessageHighlight] Failed to load keywords:', err);
    }
  }
  
  async function loadMessageTags() {
    if (!messageId) return;
    
    try {
      const response = await api.get(`/api/messages/${messageId}/tags`);
      if (response.tags && response.tags.length > 0) {
        messageTags = response.tags;
        // Use server-provided tags for highlighting
        highlightedContent = applyHighlights(trimmedContent, messageTags);
      } else {
        // No tags from server, fall back to client-side highlighting
        console.debug('[MessageHighlight] No server tags for message', messageId, '- using client-side highlighting');
        highlightedContent = processContent(trimmedContent);
      }
    } catch (err) {
      console.error('[MessageHighlight] Failed to load message tags:', err);
      // Fallback to client-side highlighting
      highlightedContent = processContent(trimmedContent);
    }
  }
  
  function processContent(text) {
    if (!text || keywords.length === 0) return text;
    
    // Debug: Log Chinese keyword processing
    const chineseKeywords = keywords.filter(k => /[一-龥]/.test(k.keyword));
    if (chineseKeywords.length > 0) {
      console.debug('[MessageHighlight] Processing Chinese keywords:', chineseKeywords);
      console.debug('[MessageHighlight] Text to search:', text);
    }
    
    // Find all matches
    const matches = [];
    
    for (const keyword of keywords) {
      const keywordMatches = findMatches(text, keyword);
      if (keywordMatches.length > 0 && /[一-龥]/.test(keyword.keyword)) {
        console.debug('[MessageHighlight] Found Chinese matches for', keyword.keyword, ':', keywordMatches);
      }
      for (const match of keywordMatches) {
        matches.push({
          ...match,
          keyword
        });
      }
    }
    
    // Sort matches by position and priority
    matches.sort((a, b) => {
      if (a.position !== b.position) {
        return a.position - b.position;
      }
      // If positions are the same, sort by priority (higher first)
      return (b.keyword.priority || 0) - (a.keyword.priority || 0);
    });
    
    // Remove overlapping matches (keep higher priority ones)
    const filteredMatches = [];
    let lastEnd = -1;
    
    for (const match of matches) {
      // Debug logging for Chinese keywords
      if (/[一-龥]/.test(match.keyword.keyword)) {
        console.debug(`[MessageHighlight] Checking match:`, {
          keyword: match.keyword.keyword,
          position: match.position,
          text: match.text,
          lastEnd: lastEnd,
          willAdd: match.position >= lastEnd
        });
      }
      
      if (match.position >= lastEnd) {
        filteredMatches.push(match);
        lastEnd = match.position + match.text.length;
      } else if (match.position + match.text.length > lastEnd) {
        // This match starts before the last one ended but extends beyond it
        // This can happen with overlapping keywords of different lengths
        // Keep the match if it has higher priority than what we already have
        const overlappingMatch = filteredMatches[filteredMatches.length - 1];
        if ((match.keyword.priority || 0) > (overlappingMatch.keyword.priority || 0)) {
          // Replace with higher priority match
          filteredMatches[filteredMatches.length - 1] = match;
          lastEnd = match.position + match.text.length;
        }
      }
    }
    
    if (matches.length > 0 && chineseKeywords.length > 0) {
      console.debug('[MessageHighlight] All matches before filtering:', matches);
      console.debug('[MessageHighlight] Filtered matches:', filteredMatches);
    }
    
    // Apply highlights
    const highlightData = filteredMatches.map(m => ({
      keyword_tag_id: m.keyword.id,
      matched_text: m.text,
      position: m.position,
      keyword: m.keyword.keyword,
      tag: m.keyword.tag,
      color: m.keyword.color
    }));
    
    if (chineseKeywords.length > 0 && highlightData.length !== matches.length) {
      console.debug('[MessageHighlight] Filtered matches (some were removed):', highlightData);
      console.debug('[MessageHighlight] Original matches count:', matches.length, 'Filtered count:', highlightData.length);
    }
    
    return applyHighlights(text, highlightData);
  }
  
  function findMatches(text, keyword) {
    const matches = [];
    
    if (!text || !keyword.keyword) return matches;
    
    let searchText = keyword.case_sensitive ? text : text.toLowerCase();
    let searchKeyword = keyword.case_sensitive ? keyword.keyword : keyword.keyword.toLowerCase();
    
    if (keyword.whole_word) {
      // Create word boundary regex
      const wordBoundary = `\\b${escapeRegex(searchKeyword)}\\b`;
      const regex = new RegExp(wordBoundary, keyword.case_sensitive ? 'g' : 'gi');
      
      let match;
      while ((match = regex.exec(text)) !== null) {
        matches.push({
          text: match[0],
          position: match.index
        });
      }
    } else {
      // Simple substring search
      let position = 0;
      while ((position = searchText.indexOf(searchKeyword, position)) !== -1) {
        matches.push({
          text: text.substr(position, keyword.keyword.length),
          position: position
        });
        position += keyword.keyword.length;
      }
    }
    
    // Debug logging for Chinese keywords
    if (/[一-龥]/.test(keyword.keyword) && matches.length > 0) {
      console.debug(`[MessageHighlight] findMatches for "${keyword.keyword}": found ${matches.length} matches`, matches);
    }
    
    return matches;
  }
  
  function escapeRegex(str) {
    return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  }
  
  function applyHighlights(text, tags) {
    if (!text || tags.length === 0) {
      extractedTags = [];
      if (onTagsExtracted) onTagsExtracted([]);
      return text;
    }
    
    // Sort tags by position
    tags.sort((a, b) => a.position - b.position);
    
    // Extract unique tags for display above the message
    const uniqueTags = new Map();
    for (const tag of tags) {
      if (!uniqueTags.has(tag.tag)) {
        uniqueTags.set(tag.tag, {
          tag: tag.tag,
          color: tag.color || '#3B82F6',
          count: 1
        });
      } else {
        uniqueTags.get(tag.tag).count++;
      }
    }
    extractedTags = Array.from(uniqueTags.values());
    if (onTagsExtracted) onTagsExtracted(extractedTags);
    
    let result = '';
    let lastPos = 0;
    
    for (const tag of tags) {
      // Add text before the match
      result += escapeHtml(text.substring(lastPos, tag.position));
      
      // Add highlighted match with WebGPU-inspired styling
      const matchedText = escapeHtml(tag.matched_text);
      const highlightId = `highlight-${tag.position}-${Date.now()}`;
      
      result += `<span class="keyword-highlight-webgpu" data-color="${tag.color || '#3B82F6'}" data-tag="${escapeHtml(tag.tag)}" id="${highlightId}">${matchedText}</span>`;
      
      lastPos = tag.position + tag.matched_text.length;
    }
    
    // Add remaining text
    result += escapeHtml(text.substring(lastPos));
    
    return result;
  }
  
  function escapeHtml(text) {
    const div = document.createElement('div');
    div.textContent = text;
    return div.innerHTML;
  }
  
  function hexToRgba(hex, alpha) {
    const r = parseInt(hex.slice(1, 3), 16);
    const g = parseInt(hex.slice(3, 5), 16);
    const b = parseInt(hex.slice(5, 7), 16);
    return `rgba(${r}, ${g}, ${b}, ${alpha})`;
  }
</script>

{#if loading}
  <span class="text-xs lg:text-sm text-white font-medium break-words high-contrast">{trimmedContent}</span>
{:else}
  <span class="text-xs lg:text-sm text-white font-medium break-words high-contrast message-with-highlights" bind:this={containerEl}>{@html highlightedContent || trimmedContent}</span>
{/if}

<style>
  
  :global(.keyword-highlight-webgpu) {
    position: relative;
    display: inline;
    padding: 0 0.125rem;
    margin: 0;
    border-radius: 0.125rem;
    font-weight: 600;
    text-shadow: 0 0 6px var(--highlight-color, #3B82F6);
    transition: color 0.3s ease, background 0.3s ease, filter 0.3s ease;
    background: rgba(59, 130, 246, 0.08);
    vertical-align: baseline;
    line-height: inherit;
    border-bottom: 2px solid var(--highlight-color, #3B82F6);
  }
  
  /* Removed ::before pseudo-element to reduce visual clutter */
  
  /* Removed ::after pseudo-element to reduce spacing issues */
  
  :global(.keyword-highlight-webgpu:hover) {
    filter: brightness(1.2);
  }
  
  /* Removed ::after hover effect */
  
  :global(.message-with-highlights) {
    display: inline;
    line-height: inherit;
  }
  
  /* Removed animations to simplify the highlight effect */
  
  /* Removed unused animation */
</style>