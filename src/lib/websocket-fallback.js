// WebSocket with fallback to workers.dev domain for custom domains
export function getWebSocketUrl(token) {
  const currentOrigin = window.location.origin;
  
  // If we're on a custom domain, try to use the workers.dev domain for WebSocket
  if (!currentOrigin.includes('workers.dev')) {
    // Fallback to workers.dev domain for WebSocket connections
    const wsOrigin = 'https://sms-dashboard.xiongchenyu6.workers.dev'
      .replace('http://', 'ws://')
      .replace('https://', 'wss://');
    return `${wsOrigin}/api/ws?token=${token}`;
  }
  
  // Use the current domain for WebSocket
  const wsUrl = currentOrigin
    .replace('http://', 'ws://')
    .replace('https://', 'wss://');
  return `${wsUrl}/api/ws?token=${token}`;
}