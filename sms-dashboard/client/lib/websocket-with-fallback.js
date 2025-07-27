// Server-Sent Events real-time service
export class RealtimeService {
  constructor() {
    this.eventSource = null;
    this.reconnectInterval = null;
    this.reconnectAttempts = 0;
    this.maxReconnectAttempts = window.APP_CONFIG?.client?.realtime?.maxReconnectAttempts || 5;
    this.reconnectDelay = window.APP_CONFIG?.client?.realtime?.reconnectDelay || 3000;
    this.callbacks = new Map();
    this.isIntentionallyClosed = false;
    this.isConnected = false;
    this.token = null; // Store auth token for API requests
  }

  async connect(token) {
    console.log('[RealtimeService] connect() called with token:', !!token);
    this.isIntentionallyClosed = false;
    this.token = token; // Store token for API requests
    
    if (!token) {
      console.error('[RealtimeService] No token provided');
      throw new Error('No auth token available');
    }

    try {
      await this.connectSSE(token);
    } catch (sseError) {
      console.error('SSE connection failed:', sseError);
      this.scheduleReconnect(token);
    }
  }

  async connectSSE(token) {
    return new Promise((resolve, reject) => {
      const baseUrl = import.meta.env.VITE_API_BASE_URL || 
        (typeof window !== 'undefined' ? window.location.origin : '');
      
      console.log('[RealtimeService] Attempting SSE connection...');
      
      // Create EventSource with proper authentication
      // Note: EventSource doesn't support custom headers, so we use URL parameter for auth
      this.eventSource = new EventSource(`${baseUrl}/api/sse?token=${encodeURIComponent(token)}`);
      
      let connectionResolved = false;
      
      this.eventSource.onopen = () => {
        console.log('[RealtimeService] SSE connected successfully');
        this.isConnected = true;
        this.reconnectAttempts = 0;
        
        if (!connectionResolved) {
          connectionResolved = true;
          resolve();
        }
      };
      
      this.eventSource.onmessage = (event) => {
        try {
          const message = JSON.parse(event.data);
          console.log('[RealtimeService] SSE message received:', message.type, message);
          this.handleMessage(message);
          
          // If this is the first message and connection hasn't resolved yet, resolve it
          if (!connectionResolved) {
            connectionResolved = true;
            resolve();
          }
        } catch (error) {
          console.error('[RealtimeService] Failed to parse SSE message:', error);
        }
      };
      
      this.eventSource.onerror = (error) => {
        console.error('[RealtimeService] SSE error:', error);
        this.isConnected = false;
        
        if (this.eventSource) {
          this.eventSource.close();
        }
        
        if (!connectionResolved) {
          connectionResolved = true;
          reject(new Error('SSE connection failed'));
        } else if (!this.isIntentionallyClosed) {
          this.scheduleReconnect(token);
        }
      };
      
      // Timeout for initial connection
      setTimeout(() => {
        if (!connectionResolved) {
          connectionResolved = true;
          reject(new Error('SSE connection timeout'));
        }
      }, 10000);
    });
  }

  disconnect() {
    console.log('[RealtimeService] Disconnecting...');
    this.isIntentionallyClosed = true;
    this.isConnected = false;
    this.clearReconnectInterval();
    
    if (this.eventSource) {
      this.eventSource.close();
      this.eventSource = null;
    }
  }

  handleMessage(message) {
    // Emit to specific event listeners
    const callbacks = this.callbacks.get(message.type);
    if (callbacks) {
      callbacks.forEach(callback => callback(message));
    }

    // Emit to wildcard listeners
    const wildcardCallbacks = this.callbacks.get('*');
    if (wildcardCallbacks) {
      wildcardCallbacks.forEach(callback => callback(message));
    }
  }

  on(event, callback) {
    if (!this.callbacks.has(event)) {
      this.callbacks.set(event, new Set());
    }
    
    this.callbacks.get(event).add(callback);
    
    // Return unsubscribe function
    return () => {
      const callbacks = this.callbacks.get(event);
      if (callbacks) {
        callbacks.delete(callback);
        if (callbacks.size === 0) {
          this.callbacks.delete(event);
        }
      }
    };
  }

  // SSE is one-way communication only - no send capability
  send(data) {
    console.warn('[RealtimeService] SSE is one-way communication - cannot send data:', data);
  }

  // For API requests, use regular HTTP calls instead of real-time connection
  async request(type, data = {}) {
    console.warn('[RealtimeService] Use regular HTTP API calls instead of request() method for SSE');
    throw new Error('SSE does not support request-response pattern. Use regular HTTP API calls.');
  }

  scheduleReconnect(token) {
    if (this.reconnectAttempts >= this.maxReconnectAttempts) {
      // Max reconnection attempts reached
      return;
    }

    this.clearReconnectInterval();
    
    this.reconnectAttempts++;
    const delay = this.reconnectDelay * Math.pow(2, Math.min(this.reconnectAttempts - 1, 3));
    
    // Reconnecting...
    
    this.reconnectInterval = setTimeout(() => {
      this.connect(token);
    }, delay);
  }

  clearReconnectInterval() {
    if (this.reconnectInterval) {
      clearTimeout(this.reconnectInterval);
      this.reconnectInterval = null;
    }
  }

  isConnected() {
    return this.eventSource !== null && this.eventSource.readyState === EventSource.OPEN;
  }

  getConnectionType() {
    return 'sse';
  }
}

export const realtimeService = new RealtimeService();