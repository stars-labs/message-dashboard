import * as Sentry from '@sentry/svelte'

/**
 * Sentry utility functions for error tracking and monitoring
 */

/**
 * Capture an exception with additional context
 * @param {Error} error - The error to capture
 * @param {Object} context - Additional context to attach
 * @param {string} level - Severity level (fatal, error, warning, info, debug)
 */
export function captureException(error, context = {}, level = 'error') {
  Sentry.withScope((scope) => {
    scope.setLevel(level)
    
    // Add context
    Object.keys(context).forEach(key => {
      scope.setContext(key, context[key])
    })
    
    // Add breadcrumb
    Sentry.addBreadcrumb({
      message: error.message,
      level: level,
      category: 'error',
      data: context,
      timestamp: Date.now() / 1000
    })
    
    Sentry.captureException(error)
  })
}

/**
 * Log a message with context
 * @param {string} message - The message to log
 * @param {string} level - Severity level
 * @param {Object} extra - Extra data to attach
 */
export function logMessage(message, level = 'info', extra = {}) {
  Sentry.captureMessage(message, {
    level,
    extra
  })
}

/**
 * Add a breadcrumb for better error context
 * @param {string} message - Breadcrumb message
 * @param {string} category - Category (e.g., 'api', 'navigation', 'user-action')
 * @param {Object} data - Additional data
 */
export function addBreadcrumb(message, category = 'custom', data = {}) {
  Sentry.addBreadcrumb({
    message,
    category,
    level: 'info',
    data,
    timestamp: Date.now() / 1000
  })
}

/**
 * Set user context for better error tracking
 * @param {Object} user - User object with id, email, username
 */
export function setUserContext(user) {
  if (!user) {
    Sentry.setUser(null)
    return
  }
  
  Sentry.setUser({
    id: user.sub || user.id,
    email: user.email,
    username: user.nickname || user.username,
    roles: user.roles || []
  })
}

/**
 * Track API errors with context
 * @param {string} endpoint - API endpoint
 * @param {number} status - HTTP status code
 * @param {Object} error - Error details
 * @param {Object} requestData - Request data
 */
export function trackApiError(endpoint, status, error, requestData = {}) {
  const errorMessage = `API Error: ${endpoint} returned ${status}`
  
  Sentry.withScope((scope) => {
    scope.setTag('api.endpoint', endpoint)
    scope.setTag('api.status', status)
    scope.setContext('api_request', {
      endpoint,
      status,
      requestData,
      timestamp: new Date().toISOString()
    })
    scope.setContext('api_error', error)
    
    // Add breadcrumb
    Sentry.addBreadcrumb({
      type: 'http',
      category: 'api',
      message: errorMessage,
      level: status >= 500 ? 'error' : 'warning',
      data: {
        endpoint,
        status,
        error: error.message || error
      }
    })
    
    // Capture based on status
    if (status >= 500) {
      Sentry.captureException(new Error(errorMessage))
    } else if (status >= 400) {
      Sentry.captureMessage(errorMessage, 'warning')
    }
  })
}

/**
 * Start a span for performance monitoring
 * @param {string} name - Span name
 * @param {string} op - Operation name (e.g., 'navigation', 'api.request')
 * @returns {Object} Span object
 */
export function startSpan(name, op = 'custom') {
  return Sentry.startSpan({
    name,
    op,
    attributes: {
      component: 'frontend'
    }
  }, span => span)
}

/**
 * Track component lifecycle errors
 * @param {string} componentName - Name of the component
 * @param {string} lifecycle - Lifecycle phase (mount, update, destroy)
 * @param {Error} error - The error that occurred
 */
export function trackComponentError(componentName, lifecycle, error) {
  Sentry.withScope((scope) => {
    scope.setTag('component', componentName)
    scope.setTag('lifecycle', lifecycle)
    scope.setContext('component_error', {
      component: componentName,
      lifecycle,
      timestamp: new Date().toISOString()
    })
    
    Sentry.captureException(error)
  })
}

/**
 * Track WebSocket errors
 * @param {string} event - WebSocket event type
 * @param {Object} error - Error details
 * @param {Object} context - Additional context
 */
export function trackWebSocketError(event, error, context = {}) {
  Sentry.withScope((scope) => {
    scope.setTag('websocket.event', event)
    scope.setContext('websocket', {
      event,
      ...context,
      timestamp: new Date().toISOString()
    })
    
    Sentry.addBreadcrumb({
      type: 'websocket',
      category: 'websocket',
      message: `WebSocket ${event} error`,
      level: 'error',
      data: { event, error: error.message || error }
    })
    
    Sentry.captureException(error instanceof Error ? error : new Error(`WebSocket ${event}: ${error}`))
  })
}

/**
 * Track user interactions for better context
 * @param {string} action - Action performed (e.g., 'click', 'submit')
 * @param {string} element - Element identifier
 * @param {Object} data - Additional data
 */
export function trackUserInteraction(action, element, data = {}) {
  Sentry.addBreadcrumb({
    category: 'ui.interaction',
    message: `User ${action} on ${element}`,
    level: 'info',
    data: {
      action,
      element,
      ...data,
      timestamp: new Date().toISOString()
    }
  })
}

/**
 * Create an error boundary for Svelte components
 * @param {Function} component - The component to wrap
 * @param {string} componentName - Name of the component for tracking
 */
export function withErrorBoundary(component, componentName) {
  return {
    ...component,
    onMount() {
      try {
        component.onMount?.()
      } catch (error) {
        trackComponentError(componentName, 'mount', error)
        throw error
      }
    },
    onDestroy() {
      try {
        component.onDestroy?.()
      } catch (error) {
        trackComponentError(componentName, 'destroy', error)
        throw error
      }
    }
  }
}

export default {
  captureException,
  logMessage,
  addBreadcrumb,
  setUserContext,
  trackApiError,
  startSpan,
  trackComponentError,
  trackWebSocketError,
  trackUserInteraction,
  withErrorBoundary
}