// Enhanced WebSocket service with SSE fallback
export class RealtimeService {
  constructor() {
    this.ws = null;
    this.eventSource = null;
    this.connectionType = null;
    this.reconnectInterval = null;
    this.reconnectAttempts = 0;
    this.maxReconnectAttempts = 5;
    this.reconnectDelay = 3000;
    this.callbacks = new Map();
    this.isIntentionallyClosed = false;
  }

  async connect(token) {
    console.log('[RealtimeService] connect() called with token:', token);
    this.isIntentionallyClosed = false;
    
    if (!token) {
      console.error('[RealtimeService] No token provided');
      throw new Error('No auth token available');
    }

    // Try WebSocket first
    try {
      await this.connectWebSocket(token);
    } catch (wsError) {
      // WebSocket connection failed, falling back to SSE
      console.error('WebSocket connection failed:', wsError);
      
      // Fall back to Server-Sent Events
      try {
        console.log('Falling back to SSE...');
        await this.connectSSE(token);
      } catch (sseError) {
        // SSE connection also failed
        console.error('SSE connection also failed:', sseError);
        this.scheduleReconnect(token);
      }
    }
  }

  async connectWebSocket(token) {
    return new Promise((resolve, reject) => {
      try {
        const baseUrl = import.meta.env.VITE_API_BASE_URL || 
          (typeof window !== 'undefined' ? window.location.origin : '');
        
        const wsUrl = baseUrl
          .replace('http://', 'ws://')
          .replace('https://', 'wss://');
        
        // Attempting WebSocket connection
        console.log('Attempting WebSocket connection to:', `${wsUrl}/api/ws`);
        this.ws = new WebSocket(`${wsUrl}/api/ws`);
        
        const timeout = setTimeout(() => {
          if (this.ws.readyState !== WebSocket.OPEN) {
            this.ws.close();
            reject(new Error('WebSocket connection timeout'));
          }
        }, 5000); // 5 second timeout

        this.ws.onopen = () => {
          clearTimeout(timeout);
          // WebSocket connected successfully
          console.log('WebSocket connected successfully');
          this.connectionType = 'websocket';
          this.reconnectAttempts = 0;
          
          // Subscribe to channels
          this.send({
            type: 'subscribe',
            channels: ['messages', 'phones']
          });
          
          resolve();
        };

        this.ws.onmessage = (event) => {
          try {
            const message = JSON.parse(event.data);
            this.handleMessage(message);
          } catch (error) {
            // Failed to parse WebSocket message
          }
        };

        this.ws.onerror = (error) => {
          clearTimeout(timeout);
          // WebSocket error
          console.error('WebSocket error:', error);
          reject(error);
        };

        this.ws.onclose = () => {
          clearTimeout(timeout);
          // WebSocket disconnected
          this.connectionType = null;
          
          if (!this.isIntentionallyClosed) {
            reject(new Error('WebSocket closed unexpectedly'));
          }
        };
      } catch (error) {
        reject(error);
      }
    });
  }

  async connectSSE(token) {
    const baseUrl = import.meta.env.VITE_API_BASE_URL || 
      (typeof window !== 'undefined' ? window.location.origin : '');
    
    // Attempting SSE connection
    
    this.eventSource = new EventSource(`${baseUrl}/api/sse?token=${token}`);
    this.connectionType = 'sse';
    
    this.eventSource.onopen = () => {
      // SSE connected successfully
      this.reconnectAttempts = 0;
    };
    
    this.eventSource.onmessage = (event) => {
      try {
        const message = JSON.parse(event.data);
        this.handleMessage(message);
      } catch (error) {
        // Failed to parse SSE message
      }
    };
    
    this.eventSource.onerror = (error) => {
      // SSE error
      this.eventSource.close();
      this.connectionType = null;
      
      if (!this.isIntentionallyClosed) {
        this.scheduleReconnect(token);
      }
    };
  }

  disconnect() {
    this.isIntentionallyClosed = true;
    this.clearReconnectInterval();
    
    if (this.ws) {
      this.ws.close();
      this.ws = null;
    }
    
    if (this.eventSource) {
      this.eventSource.close();
      this.eventSource = null;
    }
    
    this.connectionType = null;
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

  send(data) {
    if (this.connectionType === 'websocket' && this.ws && this.ws.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify(data));
    } else if (this.connectionType === 'sse') {
      // SSE is one-way communication, log warning
      // Cannot send data over SSE connection (one-way only)
    }
  }

  // Request-response pattern for API calls over WebSocket
  async request(type, data = {}) {
    return new Promise((resolve, reject) => {
      if (this.connectionType !== 'websocket' || !this.ws || this.ws.readyState !== WebSocket.OPEN) {
        reject(new Error('WebSocket not connected'));
        return;
      }

      const requestId = `req_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
      
      // Set up one-time listener for the response
      const responseHandler = (message) => {
        if (message.request_id === requestId) {
          if (message.type === 'response' && message.data) {
            if (message.data.error) {
              reject(new Error(message.data.error));
            } else {
              resolve(message.data);
            }
          } else if (message.type === 'error') {
            reject(new Error(message.data?.message || 'Request failed'));
          }
        }
      };

      // Listen for response
      const unsubscribe = this.on('response', responseHandler);
      const errorUnsubscribe = this.on('error', responseHandler);

      // Send request
      this.send({
        type: 'request',
        request_id: requestId,
        method: type,
        data: data
      });

      // Clean up listeners after timeout
      setTimeout(() => {
        unsubscribe();
        errorUnsubscribe();
        reject(new Error('Request timeout'));
      }, 10000); // 10 second timeout
    });
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
    return this.connectionType !== null && (
      (this.connectionType === 'websocket' && this.ws !== null && this.ws.readyState === WebSocket.OPEN) ||
      (this.connectionType === 'sse' && this.eventSource !== null && this.eventSource.readyState === EventSource.OPEN)
    );
  }

  getConnectionType() {
    return this.connectionType;
  }
}

export const realtimeService = new RealtimeService();