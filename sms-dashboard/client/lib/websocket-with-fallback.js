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
    this.isIntentionallyClosed = false;
    
    if (!token) {
      throw new Error('No auth token available');
    }

    // Try WebSocket first
    try {
      await this.connectWebSocket(token);
    } catch (wsError) {
      console.warn('WebSocket connection failed, falling back to SSE:', wsError);
      
      // Fall back to Server-Sent Events
      try {
        await this.connectSSE(token);
      } catch (sseError) {
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
        
        console.log('Attempting WebSocket connection:', `${wsUrl}/api/ws`);
        this.ws = new WebSocket(`${wsUrl}/api/ws?token=${token}`);
        
        const timeout = setTimeout(() => {
          if (this.ws.readyState !== WebSocket.OPEN) {
            this.ws.close();
            reject(new Error('WebSocket connection timeout'));
          }
        }, 5000); // 5 second timeout

        this.ws.onopen = () => {
          clearTimeout(timeout);
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
            console.error('Failed to parse WebSocket message:', error);
          }
        };

        this.ws.onerror = (error) => {
          clearTimeout(timeout);
          console.error('WebSocket error:', error);
          reject(error);
        };

        this.ws.onclose = () => {
          clearTimeout(timeout);
          console.log('WebSocket disconnected');
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
    
    console.log('Attempting SSE connection:', `${baseUrl}/api/sse`);
    
    this.eventSource = new EventSource(`${baseUrl}/api/sse?token=${token}`);
    this.connectionType = 'sse';
    
    this.eventSource.onopen = () => {
      console.log('SSE connected successfully');
      this.reconnectAttempts = 0;
    };
    
    this.eventSource.onmessage = (event) => {
      try {
        const message = JSON.parse(event.data);
        this.handleMessage(message);
      } catch (error) {
        console.error('Failed to parse SSE message:', error);
      }
    };
    
    this.eventSource.onerror = (error) => {
      console.error('SSE error:', error);
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
      console.warn('Cannot send data over SSE connection (one-way only)');
    }
  }

  scheduleReconnect(token) {
    if (this.reconnectAttempts >= this.maxReconnectAttempts) {
      console.error('Max reconnection attempts reached');
      return;
    }

    this.clearReconnectInterval();
    
    this.reconnectAttempts++;
    const delay = this.reconnectDelay * Math.pow(2, Math.min(this.reconnectAttempts - 1, 3));
    
    console.log(`Reconnecting in ${delay / 1000} seconds...`);
    
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