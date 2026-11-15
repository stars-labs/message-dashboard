import { sendContract } from './api.js';
import { auth } from './auth.js';
import { contractClient } from './contract-link.js';

/**
 * The routes served through the contract, for a signed-in dashboard. Failures
 * arrive as ApiError, as with `request`, and a 401 signs the user out.
 */
export const contractApi = contractClient(() => auth.baseUrl, sendContract);
