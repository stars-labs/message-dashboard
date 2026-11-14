// The active keyword list, loaded once and shared by the views that highlight
// keyword matches.
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

const _keywords = writable<KeywordTagRow[]>([]);
const _loading = writable(false);

export const keywords = { subscribe: _keywords.subscribe };

async function loadKeywords(): Promise<KeywordTagRow[]> {
  if (get(_loading)) return []; // Prevent concurrent loads

  _loading.set(true);

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
    _loading.set(false);
  }
}

export const tagActions = { loadKeywords };
