# Sentry Error Tracking Implementation

## Overview
Comprehensive error tracking and monitoring system implemented using Sentry SDK for the SMS Dashboard frontend application.

## Features Implemented

### 1. Core Sentry Integration
- **Location**: `client/main.js`
- **Configuration**:
  - Environment-based configuration (development/production)
  - Performance monitoring with transaction sampling
  - Session replay for debugging (10% sampling, 100% on errors)
  - Release tracking for version management
  - Console error capture
  - Stack trace attachment

### 2. User Context Tracking
- **Location**: `client/lib/auth.js`
- Automatically sets user context on login/logout
- Tracks user ID, email, and username
- Clears context on logout

### 3. API Error Tracking
- **Location**: `client/lib/api.js`
- Automatic error tracking for all API calls
- Performance monitoring for HTTP requests
- Network error detection
- Response status tracking
- Request/response breadcrumbs

### 4. WebSocket/SSE Error Handling
- **Location**: `client/lib/websocket-with-fallback.js`
- Real-time connection error tracking
- Reconnection attempt monitoring
- Connection state breadcrumbs

### 5. Error Utilities
- **Location**: `client/lib/sentry-utils.js`
- Comprehensive error tracking utilities:
  - `captureException()` - Enhanced exception capture with context
  - `trackApiError()` - API-specific error tracking
  - `trackWebSocketError()` - WebSocket error tracking
  - `trackComponentError()` - Component lifecycle error tracking
  - `trackUserInteraction()` - User action tracking
  - `addBreadcrumb()` - Custom breadcrumb creation
  - `startTransaction()` - Performance monitoring

### 6. Error Boundaries
- **Location**: `client/lib/ErrorBoundary.svelte`
- Svelte component error boundary
- Graceful error handling with fallback UI
- Development mode error details
- Error recovery mechanism

### 7. Navigation & Interaction Tracking
- **Location**: `client/App.svelte`
- Tab navigation tracking
- User interaction breadcrumbs
- View change monitoring

### 8. Testing Component
- **Location**: `client/lib/SentryTest.svelte`
- Development-only testing interface
- Test various error types:
  - Basic JavaScript errors
  - TypeErrors
  - API errors
  - Network errors
  - Unhandled promise rejections
  - Log messages

## Configuration

### Environment Variables
```javascript
// Automatically configured based on build mode
environment: import.meta.env.MODE || 'development'
release: import.meta.env.VITE_APP_VERSION || 'development'
```

### DSN Configuration
```javascript
dsn: "https://f3602eef5ad1e3123c189d8b13671caf@o4509897543122944.ingest.us.sentry.io/4509897554460672"
```

### Performance Monitoring
- Production: 10% transaction sampling
- Development: 100% transaction sampling

### Session Replay
- Regular sessions: 10% sampling
- Sessions with errors: 100% sampling

## Usage

### Manual Error Capture
```javascript
import { captureException } from './lib/sentry-utils';

try {
  // Your code
} catch (error) {
  captureException(error, { 
    context: { 
      component: 'MyComponent',
      action: 'loadData' 
    }
  });
}
```

### API Error Tracking
```javascript
import { trackApiError } from './lib/sentry-utils';

trackApiError(endpoint, status, errorData, requestData);
```

### User Interaction Tracking
```javascript
import { trackUserInteraction } from './lib/sentry-utils';

trackUserInteraction('click', 'submit-button', { formId: 'login' });
```

### Adding Breadcrumbs
```javascript
import { addBreadcrumb } from './lib/sentry-utils';

addBreadcrumb('User action', 'navigation', { 
  from: 'dashboard',
  to: 'settings' 
});
```

## Error Filtering

### Development Environment
- Network errors in development are filtered out
- Failed fetch requests are suppressed to reduce noise

### Production Environment
- All errors are captured and reported
- Enhanced with user context and breadcrumbs

## Testing

### Development Testing
1. Run the development server: `npm run dev`
2. Click the "Sentry Debug" button (bottom-right corner)
3. Test various error scenarios
4. Check Sentry dashboard for captured errors

### Production Testing
1. Deploy to production
2. Monitor Sentry dashboard at: https://sentry.io
3. Review error reports, performance metrics, and session replays

## Best Practices

1. **Always add context** to errors for better debugging
2. **Use breadcrumbs** to track user journey
3. **Set user context** after authentication
4. **Track critical API errors** with additional metadata
5. **Use error boundaries** for component-level error handling
6. **Filter sensitive data** before sending to Sentry
7. **Monitor performance** alongside errors

## Security Considerations

- `sendDefaultPii: true` is enabled for better debugging
- Ensure no sensitive data (passwords, tokens) in error messages
- Review Sentry data retention policies
- Consider data residency requirements

## Monitoring Dashboard

Access the Sentry dashboard to:
- View real-time error reports
- Analyze error trends
- Review session replays
- Monitor performance metrics
- Set up alerts and notifications

## Future Enhancements

1. Custom error grouping rules
2. Enhanced performance monitoring
3. Integration with backend error tracking
4. Automated error assignment
5. Custom dashboards and reports
6. Integration with incident management tools