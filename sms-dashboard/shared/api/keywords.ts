import * as v from 'valibot';
import { DEFAULT_KEYWORD_COLOR, normalizeKeywordColor } from '../keyword-color.js';
import { bodyObject } from './body.js';

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

export const KeywordWithUsage = v.object({ ...Keyword.entries, usage_count: v.number() });

export type KeywordWithUsage = v.InferOutput<typeof KeywordWithUsage>;

export const KeywordsResponse = v.object({ keywords: v.array(KeywordWithUsage) });

export type KeywordsResponse = v.InferOutput<typeof KeywordsResponse>;

export const KeywordResponse = v.object({ keyword: Keyword });

export type KeywordResponse = v.InferOutput<typeof KeywordResponse>;

const REQUIRED_MESSAGE = 'Keyword and tag are required';
const KEYWORD_MESSAGE = 'keyword must be a string';
const TAG_MESSAGE = 'tag must be a string';
const PRIORITY_MESSAGE = 'priority must be an integer';
const CASE_SENSITIVE_MESSAGE = 'case_sensitive must be true or false';
const WHOLE_WORD_MESSAGE = 'whole_word must be true or false';
const ACTIVE_MESSAGE = 'is_active must be true or false';
const MESSAGE_IDS_MESSAGE = 'messageIds must be an array of strings';

const Required = v.pipe(v.string(REQUIRED_MESSAGE), v.nonEmpty(REQUIRED_MESSAGE));

const Priority = v.pipe(v.number(PRIORITY_MESSAGE), v.integer(PRIORITY_MESSAGE));

/**
 * A colour reaches a CSS custom property in every operator's browser, so it must be a hex
 * literal. null and '' mean "not supplied" and resolve to `blank`.
 */
function colour<Blank>(blank: Blank) {
  return v.pipe(
    v.unknown(),
    v.rawTransform(({ dataset, addIssue, NEVER }) => {
      if (dataset.value === null || dataset.value === '') return blank;
      const check = normalizeKeywordColor(dataset.value);
      if (check.ok) return check.value;
      addIssue({ message: `Invalid color: ${check.reason}` });
      return NEVER;
    }),
  );
}

export const CreateKeywordBody = bodyObject(
  {
    keyword: Required,
    tag: Required,
    color: v.optional(colour(DEFAULT_KEYWORD_COLOR), DEFAULT_KEYWORD_COLOR),
    priority: v.nullish(Priority, 0),
    case_sensitive: v.optional(v.boolean(CASE_SENSITIVE_MESSAGE), false),
    whole_word: v.optional(v.boolean(WHOLE_WORD_MESSAGE), false),
  },
  { keyword: REQUIRED_MESSAGE, tag: REQUIRED_MESSAGE },
);

/** Only tag, colour, priority and is_active may change. */
export const UpdateKeywordBody = bodyObject(
  {
    keyword: v.optional(v.string(KEYWORD_MESSAGE)),
    tag: v.nullish(v.string(TAG_MESSAGE)),
    color: v.optional(colour(undefined)),
    priority: v.optional(v.nullable(Priority, 0)),
    case_sensitive: v.optional(v.boolean(CASE_SENSITIVE_MESSAGE)),
    whole_word: v.optional(v.boolean(WHOLE_WORD_MESSAGE)),
    is_active: v.optional(v.boolean(ACTIVE_MESSAGE)),
  },
  {},
);

export const BatchTagsBody = bodyObject(
  { messageIds: v.array(v.string(MESSAGE_IDS_MESSAGE), MESSAGE_IDS_MESSAGE) },
  { messageIds: MESSAGE_IDS_MESSAGE },
);

const BatchTag = v.object({
  id: v.number(),
  keyword: v.string(),
  tag: v.string(),
  color: v.nullable(v.string()),
  priority: v.nullable(v.number()),
  position: v.number(),
  length: v.number(),
});

export const BatchTagsResponse = v.object({
  success: v.literal(true),
  data: v.record(v.string(), v.array(BatchTag)),
});

export type BatchTagsResponse = v.InferOutput<typeof BatchTagsResponse>;

export const MessageTag = v.object({
  message_id: v.string(),
  keyword_tag_id: v.number(),
  matched_text: v.string(),
  position: v.number(),
  created_at: v.nullable(v.string()),
  keyword: v.string(),
  tag: v.string(),
  color: v.nullable(v.string()),
});

export const MessageTagsResponse = v.object({ tags: v.array(MessageTag) });

export type MessageTagsResponse = v.InferOutput<typeof MessageTagsResponse>;
