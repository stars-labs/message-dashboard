import * as v from 'valibot';
import { readJson, type Schema } from '../shared/parse-json.js';

const args = new Map<string, string | undefined>();
for (let index = 2; index < process.argv.length; index += 2) {
  const flag = process.argv[index];
  if (flag !== undefined) args.set(flag, process.argv[index + 1]);
}

function nonEmpty(value: string | null | undefined, fallback: string): string {
  return value === null || value === undefined || value === '' ? fallback : value;
}

const audience = args.get('--audience');
const clientId = args.get('--client-id');
const roleName = nonEmpty(args.get('--role'), 'balance-runner');
const domain = (process.env['AUTH0_DOMAIN'] ?? '').replace(/^https?:\/\//, '').replace(/\/+$/, '');
const m2mClientId = process.env['AUTH0_M2M_CLIENT_ID'];
const m2mClientSecret = process.env['AUTH0_M2M_CLIENT_SECRET'];

if (!audience || !clientId) throw new Error('--audience and --client-id are required');
if (!domain || !m2mClientId || !m2mClientSecret) {
  throw new Error('AUTH0_DOMAIN and Auth0 M2M credentials are required');
}

const tokenResponse = await fetch(`https://${domain}/oauth/token`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({
    grant_type: 'client_credentials',
    client_id: m2mClientId,
    client_secret: m2mClientSecret,
    audience: `https://${domain}/api/v2/`,
  }),
});
if (!tokenResponse.ok)
  throw new Error(`Auth0 Management token request failed (${tokenResponse.status})`);
const token = await readJson(tokenResponse, v.object({ access_token: v.nullish(v.string()) }));
if (!token.ok) throw new Error(`Auth0 Management token response was invalid: ${token.error}`);
const managementToken = token.value.access_token;
if (!managementToken) throw new Error('Auth0 Management token response had no access token');

type Fetched<T> = { available: true; value: T } | { available: false; status: number };

async function get<T>(path: string, schema: Schema<T>): Promise<Fetched<T>> {
  const response = await fetch(`https://${domain}/api/v2${path}`, {
    headers: { Authorization: `Bearer ${managementToken}` },
  });
  if (!response.ok) {
    return { available: false, status: response.status };
  }
  const parsed = await readJson(response, schema);
  if (!parsed.ok) throw new Error(`Auth0 ${path} response was invalid: ${parsed.error}`);
  return { available: true, value: parsed.value };
}

const ResourceServersSchema = v.array(
  v.object({
    identifier: v.nullish(v.string()),
    name: v.nullish(v.string()),
    enforce_policies: v.nullish(v.boolean()),
    token_dialect: v.nullish(v.string()),
    allow_offline_access: v.nullish(v.boolean()),
    scopes: v.nullish(v.array(v.object({ value: v.string() }))),
  }),
);
const RolesSchema = v.array(v.object({ id: v.string(), name: v.nullish(v.string()) }));
const RolePermissionsSchema = v.array(
  v.object({
    permission_name: v.string(),
    resource_server_identifier: v.nullish(v.string()),
  }),
);
const ClientGrantsSchema = v.array(
  v.object({
    subject_type: v.nullish(v.string()),
    audience: v.nullish(v.string()),
    scope: v.nullish(v.array(v.string())),
    allow_all_scopes: v.nullish(v.boolean()),
  }),
);
const BindingsSchema = v.object({
  bindings: v.nullish(
    v.array(
      v.object({
        ref: v.nullish(v.object({ value: v.nullish(v.string()) })),
        display_name: v.nullish(v.string()),
      }),
    ),
  ),
});
const ActionSchema = v.object({
  code: v.nullish(v.string()),
  name: v.nullish(v.string()),
  status: v.nullish(v.string()),
});

const resourceServers = await get('/resource-servers?per_page=100', ResourceServersSchema);
const api = resourceServers.available
  ? resourceServers.value.find((item) => item.identifier === audience)
  : undefined;

const roles = await get('/roles?per_page=100', RolesSchema);
const role = roles.available ? roles.value.find((item) => item.name === roleName) : undefined;
const rolePermissions = role
  ? await get(
      `/roles/${encodeURIComponent(role.id)}/permissions?per_page=100`,
      RolePermissionsSchema,
    )
  : ({ available: true, value: [] } satisfies Fetched<never[]>);

const clientGrants = await get(
  `/client-grants?client_id=${encodeURIComponent(clientId)}&audience=${encodeURIComponent(audience)}&per_page=100`,
  ClientGrantsSchema,
);

const bindings = await get('/actions/triggers/post-login/bindings?per_page=100', BindingsSchema);
const actionSummaries = [];
if (bindings.available && bindings.value.bindings) {
  for (const binding of bindings.value.bindings) {
    const actionId = binding.ref?.value;
    if (!actionId) continue;
    const action = await get(`/actions/actions/${encodeURIComponent(actionId)}`, ActionSchema);
    if (!action.available) {
      actionSummaries.push({
        name: nonEmpty(binding.display_name, actionId),
        unavailable: action.status,
      });
      continue;
    }
    const code = nonEmpty(action.value.code, '');
    actionSummaries.push({
      name: nonEmpty(action.value.name, nonEmpty(binding.display_name, actionId)),
      deployed: action.value.status === 'built',
      mutates_access_token_scopes:
        /accessToken\s*\.\s*(?:addScope|removeScope)|setCustomClaim\s*\(\s*['"]scope['"]/i.test(
          code,
        ),
      mentions_heartbeat_scope: code.includes('balance:runners:heartbeat'),
    });
  }
}

const report = {
  api: api
    ? {
        name: api.name,
        identifier: api.identifier,
        rbac_enabled: Boolean(api.enforce_policies),
        token_dialect: api.token_dialect,
        allow_offline_access: Boolean(api.allow_offline_access),
        scopes: (api.scopes ?? []).map(({ value }) => value).sort(),
      }
    : !resourceServers.available
      ? { unavailable: resourceServers.status }
      : { missing: true },
  role: role
    ? {
        name: role.name,
        permissions: rolePermissions.available
          ? rolePermissions.value
              .map(({ permission_name: name, resource_server_identifier: apiIdentifier }) => ({
                name,
                api: apiIdentifier,
              }))
              .sort((left, right) => left.name.localeCompare(right.name))
          : { unavailable: rolePermissions.status },
      }
    : !roles.available
      ? { unavailable: roles.status }
      : { missing: true },
  user_delegated_client_grants: clientGrants.available
    ? clientGrants.value.map((grant) => ({
        subject_type: grant.subject_type,
        audience: grant.audience,
        scopes: [...(grant.scope ?? [])].sort(),
        allow_all_scopes: Boolean(grant.allow_all_scopes),
      }))
    : { unavailable: clientGrants.status },
  post_login_actions: bindings.available ? actionSummaries : { unavailable: bindings.status },
};

console.log(JSON.stringify(report, null, 2));
