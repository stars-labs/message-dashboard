// Secrets set with `wrangler secret put`; wrangler.toml does not list them, so wrangler
// types omits them. Optional: the code reading each decides what absence means.
interface Env {
  API_KEY?: string;
  ALERT_RECIPIENTS?: string;
  AUTH0_DOMAIN?: string;
  AUTH0_CLIENT_ID?: string;
  AUTH0_CLIENT_SECRET?: string;
  AUTH0_AUDIENCE?: string;
  AUTH0_LOGIN_AUDIENCE?: string;
  AUTH0_M2M_CLIENT_ID?: string;
  AUTH0_M2M_CLIENT_SECRET?: string;
  REALTIME_APP_ID?: string;
  REALTIME_APP_SECRET?: string;
  TURN_KEY_ID?: string;
  TURN_API_TOKEN?: string;
  USE_AUTH0_ROLES?: string;
}
