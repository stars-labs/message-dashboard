import { createORPCClient } from '@orpc/client';
import type { ContractRouterClient } from '@orpc/contract';
import { ResponseValidationPlugin } from '@orpc/contract/plugins';
import { OpenAPILink } from '@orpc/openapi-client/fetch';
import { contract } from '../../shared/api/contract/index.js';
import { sendContract } from './api.js';
import { auth } from './auth.js';

/**
 * The routes served through the contract, typed from it. Answers are checked
 * against its schemas, and failures arrive as ApiError, as with `request`.
 */
export const contractApi: ContractRouterClient<typeof contract> = createORPCClient(
  new OpenAPILink(contract, {
    url: () => auth.baseUrl,
    fetch: (request) => sendContract(request),
    plugins: [new ResponseValidationPlugin(contract)],
  }),
);
