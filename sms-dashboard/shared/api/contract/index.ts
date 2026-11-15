import { auth } from './auth.js';
import { balanceCheckControl, balanceChecks, balanceRunners } from './balance.js';
import { carrierBills } from './bills.js';
import { calls } from './calls.js';
import { control } from './control.js';
import { filters } from './filters.js';
import { health } from './health.js';
import { iccidMappings } from './iccid-mappings.js';
import { keywords } from './keywords.js';
import { messages } from './messages.js';
import { users } from './users.js';
import { verification } from './verification.js';

/** Every route served through the contract; the rest still go to the legacy Router. */
export const contract = {
  control,
  balanceCheckControl,
  health,
  auth,
  users,
  messages,
  iccidMappings,
  keywords,
  filters,
  verification,
  balanceChecks,
  balanceRunners,
  carrierBills,
  calls,
};
