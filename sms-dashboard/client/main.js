import { mount } from 'svelte'
import './app.css'
import App from './App.svelte'
import * as Sentry from '@sentry/svelte'

// Initialize Sentry with all features enabled
Sentry.init({
  dsn: "https://f3602eef5ad1e3123c189d8b13671caf@o4509897543122944.ingest.us.sentry.io/4509897554460672",
  
  // Environment configuration
  environment: import.meta.env.MODE || 'development',
  release: import.meta.env.VITE_APP_VERSION || 'development',
  
  // Integrations
  integrations: [
    Sentry.browserTracingIntegration(),
    Sentry.replayIntegration({
      maskAllText: false,
      blockAllMedia: false,
    }),
    Sentry.captureConsoleIntegration({
      levels: ['error', 'warn'] // Reduced - only capture errors and warnings
    }),
    Sentry.httpClientIntegration(),
    Sentry.browserProfilingIntegration(),
  ],
  
  // Performance Monitoring - Reduced to avoid rate limiting
  tracesSampleRate: import.meta.env.MODE === 'production' ? 0.1 : 0.3,
  
  // Distributed tracing for your backend
  tracePropagationTargets: [
    "localhost",
    /^https:\/\/sexy\.qzz\.io/,
    /^https:\/\/sms-dashboard.*\.workers\.dev/,
    /\/api\//
  ],
  
  // Session Replay - Reduced to avoid rate limiting
  replaysSessionSampleRate: import.meta.env.MODE === 'production' ? 0.05 : 0.1, // 5% in prod, 10% in dev
  replaysOnErrorSampleRate: 1.0, // Always capture session on error
  
  // Profiling - Reduced to avoid rate limiting
  profilesSampleRate: import.meta.env.MODE === 'production' ? 0.05 : 0.1,
  
  // Enable all logs
  debug: import.meta.env.MODE === 'development',
  
  // Send default PII for better debugging
  sendDefaultPii: true,
  
  // Attach stack traces to all events
  attachStacktrace: true,
  
  // Auto session tracking
  autoSessionTracking: true,
  
  // Initial scope configuration
  initialScope: {
    tags: {
      component: 'frontend',
      deployment: 'cloudflare-workers',
      version: import.meta.env.VITE_APP_VERSION || 'unknown'
    },
    level: 'info'
  },
  
  // Transport options
  transportOptions: {
    keepalive: true,
  },
  
  // Breadcrumb configuration
  maxBreadcrumbs: 100,
  
  // Before send hook for filtering and rate limiting
  beforeSend(event, hint) {
    // Rate limiting - track last sent time
    const now = Date.now();
    const lastSent = window.__sentryLastSent || 0;
    const minInterval = 1000; // Minimum 1 second between events
    
    // Skip if sending too fast (except for critical errors)
    if (now - lastSent < minInterval && event.level !== 'fatal' && event.level !== 'error') {
      return null;
    }
    window.__sentryLastSent = now;
    
    // Add custom fingerprinting for better grouping
    if (event.exception) {
      const error = hint.originalException;
      
      // Custom fingerprint for network errors
      if (error?.message?.includes('Failed to fetch') || error?.message?.includes('NetworkError')) {
        event.fingerprint = ['network-error', event.request?.url];
      }
      
      // Don't send certain dev errors
      if (import.meta.env.MODE === 'development') {
        if (error?.message?.includes('Failed to fetch dynamically imported module')) {
          return null; // Vite HMR errors
        }
      }
      
      // Skip chrome extension errors
      if (error?.message?.includes('chrome-extension://') || 
          error?.stack?.includes('chrome-extension://')) {
        return null;
      }
    }
    
    // Add user agent
    if (event.request) {
      event.request.headers = {
        ...event.request.headers,
        'User-Agent': navigator.userAgent
      };
    }
    
    return event;
  },
  
  // Breadcrumb filtering and enrichment
  beforeBreadcrumb(breadcrumb, hint) {
    // Enrich navigation breadcrumbs
    if (breadcrumb.category === 'navigation') {
      breadcrumb.data = {
        ...breadcrumb.data,
        from: window.location.pathname,
        timestamp: new Date().toISOString()
      };
    }
    
    // Enrich console breadcrumbs
    if (breadcrumb.category === 'console') {
      breadcrumb.data = {
        ...breadcrumb.data,
        timestamp: new Date().toISOString()
      };
    }
    
    // Enrich fetch/xhr breadcrumbs
    if (breadcrumb.category === 'fetch' || breadcrumb.category === 'xhr') {
      const url = breadcrumb.data?.url;
      if (url) {
        // Add API endpoint classification
        if (url.includes('/api/')) {
          breadcrumb.data.api_endpoint = true;
          breadcrumb.data.endpoint = url.split('/api/')[1]?.split('?')[0];
        }
      }
    }
    
    return breadcrumb;
  },
  
  // Ignore certain errors
  ignoreErrors: [
    // Browser extensions
    'top.GLOBALS',
    'ResizeObserver loop limit exceeded',
    'ResizeObserver loop completed with undelivered notifications',
    // Facebook related
    'fb_xd_fragment',
    // Generic network errors that are usually not actionable
    'Network request failed',
    'NetworkError when attempting to fetch resource',
    // Safari specific
    'Non-Error promise rejection captured',
  ],
  
  // Deny URLs - don't send errors from these URLs
  denyUrls: [
    // Chrome extensions
    /extensions\//i,
    /^chrome:\/\//i,
    /^chrome-extension:\/\//i,
    // Firefox extensions
    /^moz-extension:\/\//i,
    // Safari extensions
    /^safari-extension:\/\//i,
  ],
})

// Only mount in the browser
let app
if (typeof window !== 'undefined') {
  app = mount(App, {
    target: document.getElementById('app'),
  })
  
  // Set initial user context if available
  const userStr = localStorage.getItem('user')
  if (userStr) {
    try {
      const user = JSON.parse(userStr)
      Sentry.setUser({
        id: user.sub,
        email: user.email,
        username: user.nickname
      })
    } catch (e) {
      console.error('Failed to parse user data for Sentry', e)
    }
  }
}

export default app
