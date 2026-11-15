import { auth } from './auth.js';
import { control } from './control.js';
import { health } from './health.js';
import { users } from './users.js';

/** Every route served through the contract; the rest still go to the legacy Router. */
export const contract = { control, health, auth, users };
