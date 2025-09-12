// Centralized tag state management following SOLID principles
import { writable, derived, get } from 'svelte/store';
import { api } from './api.js';

/**
 * Single Responsibility: Tag State Management
 * Open/Closed: Extensible for different tag sources
 * Liskov Substitution: Interface-based design
 * Interface Segregation: Focused on tag operations only
 * Dependency Inversion: Depends on abstractions (API)
 */

// Private stores - encapsulated state
const _messageTags = writable(new Map());
const _keywords = writable([]);
const _loadingStates = writable({
  keywords: false,
  tags: false
});

// Public readonly stores
export const messageTags = { subscribe: _messageTags.subscribe };
export const keywords = { subscribe: _keywords.subscribe };
export const isLoading = { subscribe: _loadingStates.subscribe };

// Derived computed values
export const tagStats = derived(_messageTags, ($messageTags) => {
  const totalMessages = $messageTags.size;
  const taggedMessages = Array.from($messageTags.values()).filter(tags => tags.length > 0).length;
  return { totalMessages, taggedMessages };
});

/**
 * Tag Service Interface - Dependency Inversion Principle
 * This allows different implementations (server, cache, mock) without changing consumers
 */
class TagService {
  // Single source of truth for keywords
  async loadKeywords() {
    const current = get(_loadingStates);
    if (current.keywords) return; // Prevent concurrent loads
    
    _loadingStates.update(state => ({ ...state, keywords: true }));
    
    try {
      const response = await api.get('/api/keywords');
      const activeKeywords = (response.keywords || [])
        .filter(k => k.is_active)
        .sort((a, b) => (b.priority || 0) - (a.priority || 0));
      
      _keywords.set(activeKeywords);
      return activeKeywords;
    } catch (error) {
      console.error('[TagService] Failed to load keywords:', error);
      _keywords.set([]);
      return [];
    } finally {
      _loadingStates.update(state => ({ ...state, keywords: false }));
    }
  }

  // Batch tag loading with deduplication
  async batchLoadTags(messageIds) {
    if (!messageIds || messageIds.length === 0) return;
    
    const current = get(_loadingStates);
    if (current.tags) return; // Prevent concurrent batch loads
    
    _loadingStates.update(state => ({ ...state, tags: true }));
    
    try {
      const response = await api.post('/api/messages/batch-tags', { messageIds });
      
      if (response.success && response.data) {
        // Atomic update - all or nothing
        _messageTags.update(currentMap => {
          const newMap = new Map(currentMap);
          for (const [messageId, tags] of Object.entries(response.data)) {
            newMap.set(messageId, tags);
          }
          return newMap;
        });
      }
    } catch (error) {
      console.error('[TagService] Failed to batch load tags:', error);
      throw error; // Let caller handle fallback
    } finally {
      _loadingStates.update(state => ({ ...state, tags: false }));
    }
  }

  // Client-side tag extraction (fallback)
  extractClientTags(messageId, content, keywords) {
    if (!content || !keywords.length) return [];
    
    const extractedTags = this._performKeywordMatching(content, keywords);
    
    // Update store atomically
    _messageTags.update(currentMap => {
      const newMap = new Map(currentMap);
      if (!newMap.has(messageId)) { // Only set if not already present
        newMap.set(messageId, extractedTags);
      }
      return newMap;
    });
    
    return extractedTags;
  }

  // Get tags for a specific message
  getMessageTags(messageId) {
    const currentTags = get(_messageTags);
    return currentTags.get(messageId) || [];
  }

  // Clear all cached tags (for refresh scenarios)
  clearTagCache() {
    _messageTags.set(new Map());
  }

  // Private method for keyword matching
  _performKeywordMatching(content, keywords) {
    const matches = [];
    const uniqueTags = new Map();
    
    for (const keyword of keywords) {
      const keywordMatches = this._findMatches(content, keyword);
      for (const match of keywordMatches) {
        if (!uniqueTags.has(keyword.tag)) {
          uniqueTags.set(keyword.tag, {
            tag: keyword.tag,
            color: keyword.color || '#3B82F6',
            count: 1
          });
        } else {
          uniqueTags.get(keyword.tag).count++;
        }
      }
    }
    
    return Array.from(uniqueTags.values());
  }

  _findMatches(text, keyword) {
    // Implementation similar to existing findMatches function
    // Moved here for single responsibility
    const matches = [];
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
          position: position
        });
        position += keyword.keyword.length;
      }
    }
    
    return matches;
  }

  _escapeRegex(str) {
    return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  }
}

// Export singleton instance
export const tagService = new TagService();

// Export convenient action functions
export const tagActions = {
  loadKeywords: () => tagService.loadKeywords(),
  batchLoadTags: (messageIds) => tagService.batchLoadTags(messageIds),
  extractClientTags: (messageId, content, keywords) => tagService.extractClientTags(messageId, content, keywords),
  getMessageTags: (messageId) => tagService.getMessageTags(messageId),
  clearCache: () => tagService.clearTagCache()
};