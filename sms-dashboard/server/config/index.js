import defaultConfig from '../../config/default.json';
import productionConfig from '../../config/production.json';

/**
 * Configuration loader that merges default and environment-specific configs
 * with environment variables and runtime values
 */
export class Config {
  constructor(env = {}, runtime = {}) {
    this.env = env;
    this.runtime = runtime;
    
    // Determine environment
    const environment = env.ENVIRONMENT || runtime.ENVIRONMENT || 'development';
    
    // Load base configuration
    this.config = this.deepMerge(
      defaultConfig,
      environment === 'production' ? productionConfig : {}
    );
    
    // Override with environment variables
    this.applyEnvironmentOverrides();
    
    // Apply runtime overrides
    this.applyRuntimeOverrides(runtime);
  }
  
  /**
   * Deep merge two objects
   */
  deepMerge(target, source) {
    const output = Object.assign({}, target);
    if (this.isObject(target) && this.isObject(source)) {
      Object.keys(source).forEach(key => {
        if (this.isObject(source[key])) {
          if (!(key in target))
            Object.assign(output, { [key]: source[key] });
          else
            output[key] = this.deepMerge(target[key], source[key]);
        } else {
          Object.assign(output, { [key]: source[key] });
        }
      });
    }
    return output;
  }
  
  /**
   * Check if value is an object
   */
  isObject(item) {
    return item && typeof item === 'object' && !Array.isArray(item);
  }
  
  /**
   * Apply environment variable overrides
   */
  applyEnvironmentOverrides() {
    // Auth0 configuration
    if (this.env.AUTH0_DOMAIN) {
      this.config.auth.auth0.domain = this.env.AUTH0_DOMAIN;
    }
    if (this.env.AUTH0_CLIENT_ID) {
      this.config.auth.auth0.clientId = this.env.AUTH0_CLIENT_ID;
    }
    if (this.env.AUTH0_CLIENT_SECRET) {
      this.config.auth.auth0.clientSecret = this.env.AUTH0_CLIENT_SECRET;
    }
    if (this.env.AUTH0_AUDIENCE) {
      this.config.auth.auth0.audience = this.env.AUTH0_AUDIENCE;
    }
    
    // API configuration
    if (this.env.API_KEY) {
      this.config.server.api.key = this.env.API_KEY;
    }
    if (this.env.WORKER_URL) {
      this.config.server.api.workerUrl = this.env.WORKER_URL;
    }
    
    // Override base URL if provided
    if (this.env.API_BASE_URL) {
      this.config.server.api.baseUrl = this.env.API_BASE_URL;
    }
  }
  
  /**
   * Apply runtime overrides (from request context, etc.)
   */
  applyRuntimeOverrides(runtime) {
    if (runtime.baseUrl) {
      this.config.server.api.baseUrl = runtime.baseUrl;
    }
  }
  
  /**
   * Get configuration value by path
   */
  get(path, defaultValue = null) {
    const keys = path.split('.');
    let current = this.config;
    
    for (const key of keys) {
      if (current && typeof current === 'object' && key in current) {
        current = current[key];
      } else {
        return defaultValue;
      }
    }
    
    return current;
  }
  
  /**
   * Get all configuration
   */
  getAll() {
    return this.config;
  }
  
  /**
   * Check if running in production
   */
  isProduction() {
    return this.config.app.environment === 'production';
  }
  
  /**
   * Get API endpoint URL
   */
  getApiEndpoint(endpoint) {
    const baseUrl = this.get('server.api.baseUrl');
    const endpoints = this.get('server.api.endpoints', {});
    return baseUrl + (endpoints[endpoint] || `/${endpoint}`);
  }
  
  /**
   * Get WebSocket configuration
   */
  getWebSocketConfig() {
    return this.get('server.websocket', {});
  }
  
  /**
   * Get daemon configuration
   */
  getDaemonConfig() {
    return this.get('server.daemon', {});
  }
  
  /**
   * Get Auth0 configuration
   */
  getAuth0Config() {
    return this.get('auth.auth0', {});
  }
}

/**
 * Create a configuration instance for Cloudflare Workers
 */
export function createConfig(env, request) {
  const runtime = {
    baseUrl: request ? new URL(request.url).origin : undefined,
    ENVIRONMENT: env.ENVIRONMENT || 'production'
  };
  
  return new Config(env, runtime);
}