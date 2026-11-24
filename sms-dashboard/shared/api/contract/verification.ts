import * as v from 'valibot';
import { ReprocessQuery, ReprocessResponse } from '../verification.js';
import { route } from './route.js';

export const verification = {
  reprocess: route(
    { kind: 'user', permission: 'filters.write' },
    'POST',
    '/api/verification/reprocess',
  )
    .route({ inputStructure: 'detailed' })
    .input(v.object({ query: ReprocessQuery }))
    .output(ReprocessResponse),
};
