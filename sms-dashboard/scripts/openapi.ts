import { OpenAPIGenerator, type OpenAPI } from '@orpc/openapi';
import { traverseContractProcedures } from '@orpc/server';
import { experimental_ValibotToJsonSchemaConverter } from '@orpc/valibot';
import * as v from 'valibot';
import packageJson from '../package.json' with { type: 'json' };
import { contract } from '../shared/api/contract/index.js';
import { Method, RouteMeta, type Access } from '../shared/api/contract/route.js';

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
    case 'runner':
      return [{ daemonKey: [] }, { auth0: [access.scope] }];
  }
}

export async function openapiDocument() {
  const doc = await new OpenAPIGenerator({
    // The converter drops what it cannot convert by default; a schema missing from the
    // document would hide its changes from the compatibility check, so that fails the
    // generation. Checks and transforms are named: they refine a type the document
    // already states, and JSON Schema cannot express them.
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
