// Centralized tag state management following SOLID principles
import { writable, get } from 'svelte/store';
import { api } from './api.js';

/** A keyword row as /api/keywords returns it. */
interface KeywordTagRow {
  id: number;
  keyword: string;
  tag: string;
  color: string | null;
  priority: number;
  case_sensitive?: boolean | number | null;
  whole_word?: boolean | number | null;
  is_active?: boolean | number | null;
}

/** A tag as the client renders it: one per tag name, with a match count. */
interface ClientTag {
  tag: string;
  color: string;
  count: number;
}

/** A matched occurrence inside a message body. */
interface TagMatch {
  text: string;
  position: number;
}

/** One message's tags. */
type MessageTagList = ClientTag[];

/**
 * Single Responsibility: Tag State Management
 * Open/Closed: Extensible for different tag sources
 * Liskov Substitution: Interface-based design
 * Interface Segregation: Focused on tag operations only
 * Dependency Inversion: Depends on abstractions (API)
 */

// Private stores - encapsulated state
const _messageTags = writable<Map<string, MessageTagList>>(new Map());
const _keywords = writable<KeywordTagRow[]>([]);
const _loadingStates = writable({
  keywords: false,
  tags: false,
});

// Public readonly stores
export const keywords = { subscribe: _keywords.subscribe };

/**
 * Tag Service Interface - Dependency Inversion Principle
 * This allows different implementations (server, cache, mock) without changing consumers
 */
class TagService {
  // Single source of truth for keywords
  async loadKeywords(): Promise<KeywordTagRow[]> {
    const current = get(_loadingStates);
    if (current.keywords) return []; // Prevent concurrent loads

    _loadingStates.update((state) => ({ ...state, keywords: true }));

    try {
      const response = await api.get('/api/keywords');
      const activeKeywords = ((response.keywords || []) as KeywordTagRow[])
        .filter((k) => k.is_active)
        .sort((a, b) => (b.priority || 0) - (a.priority || 0));

      _keywords.set(activeKeywords);
      return activeKeywords;
    } catch (error) {
      console.error('[TagService] Failed to load keywords:', error);
      _keywords.set([]);
      return [];
    } finally {
      _loadingStates.update((state) => ({ ...state, keywords: false }));
    }
  }

  // Batch tag loading with deduplication
  async batchLoadTags(messageIds: string[]): Promise<void> {
    if (!messageIds || messageIds.length === 0) return;

    const current = get(_loadingStates);
    if (current.tags) return; // Prevent concurrent batch loads

    _loadingStates.update((state) => ({ ...state, tags: true }));

    try {
      const response = await api.post('/api/messages/batch-tags', { messageIds });

      if (response.success && response.data) {
        // Atomic update - all or nothing
        _messageTags.update((currentMap) => {
          const newMap = new Map(currentMap);
          for (const [messageId, tags] of Object.entries(
            response.data as Record<string, MessageTagList>,
          )) {
            newMap.set(messageId, tags);
          }
          return newMap;
        });
      }
    } catch (error) {
      console.error('[TagService] Failed to batch load tags:', error);
      throw error; // Let caller handle fallback
    } finally {
      _loadingStates.update((state) => ({ ...state, tags: false }));
    }
  }

  // Client-side tag extraction (fallback)
  extractClientTags(
    messageId: string,
    content: string | null | undefined,
    keywordList: KeywordTagRow[],
  ): MessageTagList {
    if (!content || !keywordList.length) return [];

    const extractedTags = this._performKeywordMatching(content, keywordList);

    // Update store atomically
    _messageTags.update((currentMap) => {
      const newMap = new Map(currentMap);
      if (!newMap.has(messageId)) {
        // Only set if not already present
        newMap.set(messageId, extractedTags);
      }
      return newMap;
    });

    return extractedTags;
  }

  // Get tags for a specific message
  getMessageTags(messageId: string): MessageTagList {
    const currentTags = get(_messageTags);
    return currentTags.get(messageId) || [];
  }

  // Clear all cached tags (for refresh scenarios)
  clearTagCache(): void {
    _messageTags.set(new Map());
  }

  // Private method for keyword matching
  _performKeywordMatching(content: string, keywordList: KeywordTagRow[]): MessageTagList {
    const uniqueTags = new Map<string, ClientTag>();

    for (const keyword of keywordList) {
      // One entry per match: the count is how many times the tag fired.
      for (let seen = 0; seen < this._findMatches(content, keyword).length; seen++) {
        if (!uniqueTags.has(keyword.tag)) {
          uniqueTags.set(keyword.tag, {
            tag: keyword.tag,
            color: keyword.color || '#3B82F6',
            count: 1,
          });
        } else {
          const existing = uniqueTags.get(keyword.tag);
          if (existing) existing.count++;
        }
      }
    }

    return Array.from(uniqueTags.values());
  }

  _findMatches(text: string, keyword: KeywordTagRow): TagMatch[] {
    // Implementation similar to existing findMatches function
    // Moved here for single responsibility
    const matches: TagMatch[] = [];
    if (!text || !keyword.keyword) return matches;

    let searchText = keyword.case_sensitive ? text : text.toLowerCase();
    let searchKeyword = keyword.case_sensitive ? keyword.keyword : keyword.keyword.toLowerCase();

    if (keyword.whole_word) {
      const wordBoundary = `\\b${this._escapeRegex(searchKeyword)}\\b`;
      const regex = new RegExp(wordBoundary, keyword.case_sensitive ? 'g' : 'gi');
      let match;
      while ((match = regex.exec(text)) !== null) {
        matches.push({ text: match[0], position: match.index });
      }
    } else {
      let position = 0;
      while ((position = searchText.indexOf(searchKeyword, position)) !== -1) {
        matches.push({
          text: text.substr(position, keyword.keyword.length),
          position: position,
        });
        position += keyword.keyword.length;
      }
    }

    return matches;
  }

  _escapeRegex(str: string): string {
    return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  }
}

// Export singleton instance
export const tagService = new TagService();

// Export convenient action functions
export const tagActions = {
  loadKeywords: () => tagService.loadKeywords(),
  batchLoadTags: (messageIds: string[]) => tagService.batchLoadTags(messageIds),
  extractClientTags: (
    messageId: string,
    content: string | null | undefined,
    keywordList: KeywordTagRow[],
  ) => tagService.extractClientTags(messageId, content, keywordList),
  getMessageTags: (messageId: string) => tagService.getMessageTags(messageId),
  clearCache: () => tagService.clearTagCache(),
};
