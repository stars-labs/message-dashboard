// Active keyword rules for highlighting messages, shared by every message view.
// KeywordConfig manages the full list (active and inactive) on its own.
import { api } from './api.js';

let keywords = $state([]);
let pending = null;

export function selectActiveKeywords(rules = []) {
  return rules
    .filter((rule) => rule.is_active)
    .sort((a, b) => (b.priority || 0) - (a.priority || 0));
}

export function activeKeywords() {
  return keywords;
}

/** Concurrent callers share one request. */
export function loadActiveKeywords() {
  pending ??= api.get('/api/keywords')
    .then((response) => {
      keywords = selectActiveKeywords(response.keywords);
    })
    .catch((error) => {
      console.error('Failed to load keywords:', error);
      keywords = [];
    })
    .finally(() => {
      pending = null;
    });
  return pending;
}
