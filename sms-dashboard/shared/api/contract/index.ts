import { control } from './control.js';
import { users } from './users.js';

/** Every route served through the contract; the rest still go to the legacy Router. */
export const contract = { control, users };
