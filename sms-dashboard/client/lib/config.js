// Client-side configuration management
import defaultConfig from '../../config/default.json';
import productionConfig from '../../config/production.json';

/**
 * Load and merge configuration for the client
 */
export function loadConfig() {
  // Determine environment from meta tag or default to development
  const environment = import.meta.env.MODE || 'development';
  
  // Deep merge function
  const deepMerge = (target, source) => {
    const output = Object.assign({}, target);
    if (isObject(target) && isObject(source)) {
      Object.keys(source).forEach(key => {
        if (isObject(source[key])) {
          if (!(key in target))
            Object.assign(output, { [key]: source[key] });
          else
            output[key] = deepMerge(target[key], source[key]);
        } else {
          Object.assign(output, { [key]: source[key] });
        }
      });
    }
    return output;
  };
  
  const isObject = (item) => {
    return item && typeof item === 'object' && !Array.isArray(item);
  };
  
  // Start with default config
  let config = defaultConfig;
  
  // Merge with environment-specific config
  if (environment === 'production') {
    config = deepMerge(config, productionConfig);
  }
  
  // Override with environment variables from Vite
  if (import.meta.env.VITE_API_BASE_URL) {
    config.server.api.baseUrl = import.meta.env.VITE_API_BASE_URL;
  }
  
  if (import.meta.env.VITE_AUTH0_DOMAIN) {
    config.auth.auth0.domain = import.meta.env.VITE_AUTH0_DOMAIN;
  }
  
  if (import.meta.env.VITE_AUTH0_CLIENT_ID) {
    config.auth.auth0.clientId = import.meta.env.VITE_AUTH0_CLIENT_ID;
  }
  
  if (import.meta.env.VITE_AUTH0_AUDIENCE) {
    config.auth.auth0.audience = import.meta.env.VITE_AUTH0_AUDIENCE;
  }
  
  // Make config available globally for legacy code
  window.APP_CONFIG = config;
  
  return config;
}

/**
 * Get configuration value by path
 */
export function getConfig(path, defaultValue = null) {
  const config = window.APP_CONFIG || loadConfig();
  const keys = path.split('.');
  let current = config;
  
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
 * Get API endpoint URL
 */
export function getApiEndpoint(endpoint) {
  const config = window.APP_CONFIG || loadConfig();
  const baseUrl = getConfig('server.api.baseUrl');
  const endpoints = getConfig('server.api.endpoints', {});
  return baseUrl + (endpoints[endpoint] || `/${endpoint}`);
}

// Load configuration on module import
const config = loadConfig();
export default config;