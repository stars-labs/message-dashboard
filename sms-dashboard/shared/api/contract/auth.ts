import { MeResponse } from '../auth.js';
import { route } from './route.js';

/** The signed-in user, whatever their role, with the permissions it grants. */
export const auth = {
  me: route({ kind: 'session' }, 'GET', '/api/auth/me').output(MeResponse),
};
