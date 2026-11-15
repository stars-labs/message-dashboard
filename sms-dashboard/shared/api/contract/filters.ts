import * as v from 'valibot';
import { CreateFilterBody, FilterResponse, FiltersResponse, UpdateFilterBody } from '../filters.js';
import { HistoryRequestBody, RuleHistoryPage } from '../history.js';
import { SuccessResponse } from '../success.js';
import { route } from './route.js';

const Id = v.object({ id: v.string() });

/** Spam and marketing filter rules. Changes apply to new messages; history is explicit. */
export const filters = {
  list: route({ kind: 'user', permission: 'filters.read' }, 'GET', '/api/filters').output(
    FiltersResponse,
  ),
  create: route({ kind: 'user', permission: 'filters.write' }, 'POST', '/api/filters')
    .route({ successStatus: 201 })
    .input(CreateFilterBody)
    .output(FilterResponse),
  update: route({ kind: 'user', permission: 'filters.write' }, 'PUT', '/api/filters/{id}')
    .route({ inputStructure: 'detailed' })
    .input(v.object({ params: Id, body: UpdateFilterBody }))
    .output(FilterResponse),
  remove: route({ kind: 'user', permission: 'filters.delete' }, 'DELETE', '/api/filters/{id}')
    .route({ inputStructure: 'detailed' })
    .input(v.object({ params: Id }))
    .output(SuccessResponse),
  history: route({ kind: 'user', permission: 'filters.write' }, 'POST', '/api/filters/{id}/history')
    .route({ inputStructure: 'detailed' })
    .input(v.object({ params: Id, body: HistoryRequestBody }))
    .output(RuleHistoryPage),
};
