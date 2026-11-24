import { createORPCClient } from '@orpc/client';
import type { ContractRouterClient } from '@orpc/contract';
import { ResponseValidationPlugin } from '@orpc/contract/plugins';
import { OpenAPILink } from '@orpc/openapi-client/fetch';
import { contract } from '../../shared/api/contract/index.js';

type ContractClient = ContractRouterClient<typeof contract>;

// Answers are checked against the contract's schemas.
export function contractClient(
  baseUrl: () => string,
  send: (request: Request) => Promise<Response>,
): ContractClient {
  return createORPCClient(
    new OpenAPILink(contract, {
      url: baseUrl,
      fetch: (request) => send(request),
      plugins: [new ResponseValidationPlugin(contract)],
    }),
  );
}
