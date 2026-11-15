import * as v from 'valibot';
import { HistoryRequestBody, KeywordHistoryPage } from '../history.js';
import {
  BatchTagsBody,
  BatchTagsResponse,
  CreateKeywordBody,
  KeywordResponse,
  KeywordsResponse,
  KeywordWithUsage,
  MessageTagsResponse,
  UpdateKeywordBody,
} from '../keywords.js';
import { SuccessResponse } from '../success.js';
import { route } from './route.js';

const Id = v.object({ id: v.string() });

/** Keyword highlighting rules, and the tags they have put on messages. */
export const keywords = {
  list: route({ kind: 'user', permission: 'keywords.read' }, 'GET', '/api/keywords').output(
    KeywordsResponse,
  ),
  get: route({ kind: 'user', permission: 'keywords.read' }, 'GET', '/api/keywords/{id}')
    .route({ inputStructure: 'detailed' })
    .input(v.object({ params: Id }))
    .output(v.object({ keyword: KeywordWithUsage })),
  create: route({ kind: 'user', permission: 'keywords.write' }, 'POST', '/api/keywords')
    .route({ successStatus: 201 })
    .input(CreateKeywordBody)
    .output(KeywordResponse),
  update: route({ kind: 'user', permission: 'keywords.write' }, 'PUT', '/api/keywords/{id}')
    .route({ inputStructure: 'detailed' })
    .input(v.object({ params: Id, body: UpdateKeywordBody }))
    .output(KeywordResponse),
  remove: route({ kind: 'user', permission: 'keywords.delete' }, 'DELETE', '/api/keywords/{id}')
    .route({ inputStructure: 'detailed' })
    .input(v.object({ params: Id }))
    .output(SuccessResponse),
  history: route(
    { kind: 'user', permission: 'keywords.write' },
    'POST',
    '/api/keywords/{id}/history',
  )
    .route({ inputStructure: 'detailed' })
    .input(v.object({ params: Id, body: HistoryRequestBody }))
    .output(KeywordHistoryPage),
  batchTags: route(
    { kind: 'user', permission: 'messages.read' },
    'POST',
    '/api/messages/batch-tags',
  )
    .input(BatchTagsBody)
    .output(BatchTagsResponse),
  messageTags: route(
    { kind: 'user', permission: 'messages.read' },
    'GET',
    '/api/messages/{id}/tags',
  )
    .route({ inputStructure: 'detailed' })
    .input(v.object({ params: Id }))
    .output(MessageTagsResponse),
};
