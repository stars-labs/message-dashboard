import type { KeywordWithUsage } from '../../../shared/api/keywords.js';
import { textOr } from '../../../shared/text.js';

export interface KeywordForm {
  keyword: string;
  tag: string;
  color: string;
  priority: number;
  case_sensitive: boolean;
  whole_word: boolean;
}

export function emptyKeywordForm(): KeywordForm {
  return {
    keyword: '',
    tag: '',
    color: '#3B82F6',
    priority: 0,
    case_sensitive: false,
    whole_word: false,
  };
}

export function keywordForm(kw: KeywordWithUsage): KeywordForm {
  return {
    keyword: kw.keyword,
    tag: kw.tag,
    color: textOr(kw.color, '#3B82F6'),
    priority: kw.priority ?? 0,
    case_sensitive: Boolean(kw.case_sensitive),
    whole_word: Boolean(kw.whole_word),
  };
}
