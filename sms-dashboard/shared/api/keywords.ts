import * as v from 'valibot';

/** A keyword_tags row, every column. */
export const Keyword = v.object({
  id: v.number(),
  keyword: v.string(),
  tag: v.string(),
  color: v.nullable(v.string()),
  priority: v.nullable(v.number()),
  is_active: v.nullable(v.number()),
  case_sensitive: v.nullable(v.number()),
  whole_word: v.nullable(v.number()),
  created_by: v.nullable(v.string()),
  created_at: v.nullable(v.string()),
  updated_at: v.nullable(v.string()),
});

export type Keyword = v.InferOutput<typeof Keyword>;

/** A keyword with how many messages it has tagged. */
export const KeywordWithUsage = v.object({ ...Keyword.entries, usage_count: v.number() });

/** GET /api/keywords. */
export const KeywordsResponse = v.object({ keywords: v.array(KeywordWithUsage) });

export type KeywordsResponse = v.InferOutput<typeof KeywordsResponse>;

/** POST /api/keywords and PUT /api/keywords/:id. */
export const KeywordResponse = v.object({ keyword: Keyword });

export type KeywordResponse = v.InferOutput<typeof KeywordResponse>;
