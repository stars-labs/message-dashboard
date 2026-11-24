import { MeResponse } from '../auth.js';
import { route } from './route.js';

export const auth = {
  me: route({ kind: 'session' }, 'GET', '/api/auth/me').output(MeResponse),
};
