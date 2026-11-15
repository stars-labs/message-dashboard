// The OpenAPI document of the contract (shared/api/contract/). oRPC writes the
// paths, parameters and answers; this adds what the contract states and the
// generator cannot see: who may call each route, and the error format it answers.
import { OpenAPIGenerator, type OpenAPI } from '@orpc/openapi';
import { traverseContractProcedures } from '@orpc/server';
import { experimental_ValibotToJsonSchemaConverter } from '@orpc/valibot';
import * as v from 'valibot';
import packageJson from '../package.json' with { type: 'json' };
import { contract } from '../shared/api/contract/index.js';
import { Method, RouteMeta, type Access } from '../shared/api/contract/route.js';

// The prefix the Worker's contract entry uses to pick the daemon's error format.
const CONTROL_PREFIX = '/api/control/';

const securitySchemes: Record<string, OpenAPI.SecuritySchemeObject> = {
  session: {
    type: 'apiKey',
    in: 'cookie',
    name: 'auth_token',
    description: 'The dashboard session, set by the Auth0 login callback.',
  },
  auth0: { type: 'http', scheme: 'bearer', bearerFormat: 'JWT' },
  daemonKey: { type: 'apiKey', in: 'header', name: 'X-API-Key' },
};

const responses: Record<string, OpenAPI.ResponseObject> = {
  Problem: {
    description: 'An RFC 9457 problem.',
    content: {
      'application/problem+json': {
        schema: {
          type: 'object',
          properties: {
            type: { type: 'string' },
            title: { type: 'string' },
            status: { type: 'integer' },
            detail: { type: 'string' },
            code: { type: 'string' },
          },
          required: ['type', 'title', 'status', 'detail', 'code'],
        },
      },
    },
  },
  DaemonError: {
    description: 'The error the Pi daemon reads; shared/control-fixtures/ records each.',
    content: {
      'application/json': {
        schema: {
          type: 'object',
          properties: { success: { const: false }, error: { type: 'string' } },
          required: ['error'],
        },
      },
    },
  },
};

/** Security requirements for `access`; a permission is listed as the requirement's role. */
function security(access: Access): OpenAPI.SecurityRequirementObject[] {
  switch (access.kind) {
    case 'public':
      return [];
    case 'session':
      return [{ session: [] }, { auth0: [] }];
    case 'user':
      return [{ session: [access.permission] }, { auth0: [access.permission] }];
    case 'daemon':
      return [{ daemonKey: [] }];
  }
}

export async function openapiDocument() {
  const doc = await new OpenAPIGenerator({
    // OpenAPI 3.1 schemas are JSON Schema 2020-12. The converter's default is to
    // drop what it cannot convert; a schema left out of the document would hide
    // its changes from the compatibility check, so that fails the generation.
    // Checks and transforms, trim among them, are named: they refine a value
    // whose type the document already states, and JSON Schema cannot express them.
    schemaConverters: [
      new experimental_ValibotToJsonSchemaConverter({
        target: 'draft-2020-12',
        errorMode: 'throw',
        ignoreActions: ['check', 'transform', 'raw_transform', 'trim'],
      }),
    ],
  }).generate(contract, {
    info: { title: 'SMS Dashboard API', version: packageJson.version },
    components: { securitySchemes, responses },
  });

  traverseContractProcedures({ router: contract, path: [] }, ({ contract: procedure }) => {
    const { route } = procedure['~orpc'];
    const method = v.parse(Method, route.method).toLowerCase();
    const path = route.path ?? '';
    const operation =
      doc.paths?.[path]?.[v.parse(v.picklist(['get', 'post', 'put', 'delete']), method)];
    if (!operation) throw new Error(`the generator left out ${method} ${path}`);
    operation.security = security(v.parse(RouteMeta, procedure['~orpc'].meta).access);
    operation.responses = {
      ...operation.responses,
      default: {
        $ref: `#/components/responses/${path.startsWith(CONTROL_PREFIX) ? 'DaemonError' : 'Problem'}`,
      },
    };
  });
  return doc;
}
