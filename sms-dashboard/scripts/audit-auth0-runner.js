const args = new Map();
for (let index = 2; index < process.argv.length; index += 2) {
  args.set(process.argv[index], process.argv[index + 1]);
}

const audience = args.get('--audience');
const clientId = args.get('--client-id');
const roleName = args.get('--role') || 'balance-runner';
const domain = String(process.env.AUTH0_DOMAIN || '').replace(/^https?:\/\//, '').replace(/\/+$/, '');
const m2mClientId = process.env.AUTH0_M2M_CLIENT_ID;
const m2mClientSecret = process.env.AUTH0_M2M_CLIENT_SECRET;

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
if (!tokenResponse.ok) throw new Error(`Auth0 Management token request failed (${tokenResponse.status})`);
const managementToken = (await tokenResponse.json()).access_token;
if (!managementToken) throw new Error('Auth0 Management token response had no access token');

async function get(path) {
  const response = await fetch(`https://${domain}/api/v2${path}`, {
    headers: { Authorization: `Bearer ${managementToken}` },
  });
  if (!response.ok) {
    return { unavailable: true, status: response.status };
  }
  return response.json();
}

const resourceServers = await get('/resource-servers?per_page=100');
const api = Array.isArray(resourceServers)
  ? resourceServers.find((item) => item.identifier === audience)
  : null;

const roles = await get('/roles?per_page=100');
const role = Array.isArray(roles) ? roles.find((item) => item.name === roleName) : null;
const rolePermissions = role
  ? await get(`/roles/${encodeURIComponent(role.id)}/permissions?per_page=100`)
  : [];

const clientGrants = await get(
  `/client-grants?client_id=${encodeURIComponent(clientId)}&audience=${encodeURIComponent(audience)}&per_page=100`,
);

const bindings = await get('/actions/triggers/post-login/bindings?per_page=100');
const actionSummaries = [];
if (Array.isArray(bindings?.bindings)) {
  for (const binding of bindings.bindings) {
    const actionId = binding.ref?.value;
    if (!actionId) continue;
    const action = await get(`/actions/actions/${encodeURIComponent(actionId)}`);
    if (action?.unavailable) {
      actionSummaries.push({ name: binding.display_name || actionId, unavailable: action.status });
      continue;
    }
    const code = String(action.code || '');
    actionSummaries.push({
      name: action.name || binding.display_name || actionId,
      deployed: action.status === 'built',
      mutates_access_token_scopes: /accessToken\s*\.\s*(?:addScope|removeScope)|setCustomClaim\s*\(\s*['"]scope['"]/i.test(code),
      mentions_heartbeat_scope: code.includes('balance:runners:heartbeat'),
    });
  }
}

const report = {
  api: api ? {
    name: api.name,
    identifier: api.identifier,
    rbac_enabled: Boolean(api.enforce_policies),
    token_dialect: api.token_dialect,
    allow_offline_access: Boolean(api.allow_offline_access),
    scopes: (api.scopes || []).map(({ value }) => value).sort(),
  } : (resourceServers?.unavailable
    ? { unavailable: resourceServers.status }
    : { missing: true }),
  role: role ? {
    name: role.name,
    permissions: Array.isArray(rolePermissions)
      ? rolePermissions.map(({ permission_name: name, resource_server_identifier: apiIdentifier }) => ({
        name,
        api: apiIdentifier,
      })).sort((left, right) => left.name.localeCompare(right.name))
      : { unavailable: rolePermissions.status },
  } : (roles?.unavailable ? { unavailable: roles.status } : { missing: true }),
  user_delegated_client_grants: Array.isArray(clientGrants)
    ? clientGrants.map((grant) => ({
      subject_type: grant.subject_type,
      audience: grant.audience,
      scopes: [...(grant.scope || [])].sort(),
      allow_all_scopes: Boolean(grant.allow_all_scopes),
    }))
    : { unavailable: clientGrants.status },
  post_login_actions: bindings?.unavailable
    ? { unavailable: bindings.status }
    : actionSummaries,
};

console.log(JSON.stringify(report, null, 2));
