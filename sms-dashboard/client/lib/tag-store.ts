// The active keyword list, loaded once and shared by the views that highlight
// keyword matches.
import { writable, get } from 'svelte/store';
import { KeywordsResponse, type Keyword } from '../../shared/api/keywords.js';
import { request } from './api.js';

const _keywords = writable<Keyword[]>([]);
const _loading = writable(false);

export const keywords = { subscribe: _keywords.subscribe };

async function loadKeywords(): Promise<Keyword[]> {
  if (get(_loading)) return []; // Prevent concurrent loads

  _loading.set(true);

  try {
    const response = await request('/api/keywords', KeywordsResponse);
    const activeKeywords = response.keywords
      .filter((k) => Boolean(k.is_active))
      .sort((a, b) => (b.priority ?? 0) - (a.priority ?? 0));

    _keywords.set(activeKeywords);
    return activeKeywords;
  } catch (error) {
    console.error('[TagService] Failed to load keywords:', error);
    _keywords.set([]);
    return [];
  } finally {
    _loading.set(false);
  }
}

export const tagActions = { loadKeywords };
