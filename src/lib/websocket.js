export class WebSocketService {
  constructor() {
    this.ws = null;
    this.reconnectInterval = null;
    this.reconnectAttempts = 0;
    this.maxReconnectAttempts = 5;
    this.reconnectDelay = 3000;
    this.pingInterval = null;
    this.callbacks = new Map();
    this.isIntentionallyClosed = false;
  }

  async connect(token) {
    try {
      this.isIntentionallyClosed = false;
      
      if (!token) {
        throw new Error('No auth token available');
      }

      let baseUrl = import.meta.env.VITE_API_BASE_URL || 
        (typeof window !== 'undefined' ? window.location.origin : '');
      
      // If we're on a custom domain, try using the same domain first
      // If that fails, fallback to workers.dev will be handled in error/close handler
      console.log('WebSocket base URL:', baseUrl);
      
      const wsUrl = baseUrl
        .replace('http://', 'ws://')
        .replace('https://', 'wss://');
      
      console.log('Connecting to WebSocket:', `${wsUrl}/api/ws`);
      this.ws = new WebSocket(`${wsUrl}/api/ws?token=${token}`);

      this.ws.onopen = () => {
        console.log('WebSocket connected');
        this.reconnectAttempts = 0;
        this.clearReconnectInterval();
        this.startPingInterval();
        
        // Subscribe to message and phone events
        this.send({
          type: 'subscribe',
          channels: ['messages', 'phones']
        });
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
        console.error('WebSocket error:', error);
      };

      this.ws.onclose = () => {
        console.log('WebSocket disconnected');
        this.clearPingInterval();
        
        if (!this.isIntentionallyClosed) {
          this.scheduleReconnect(token);
        }
      };
    } catch (error) {
      console.error('Failed to connect WebSocket:', error);
      this.scheduleReconnect(token);
    }
  }

  disconnect() {
    this.isIntentionallyClosed = true;
    this.clearReconnectInterval();
    this.clearPingInterval();
    
    if (this.ws) {
      this.ws.close();
      this.ws = null;
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

  send(data) {
    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify(data));
    }
  }

  startPingInterval() {
    this.pingInterval = setInterval(() => {
      this.send({ type: 'ping' });
    }, 30000); // Ping every 30 seconds
  }

  clearPingInterval() {
    if (this.pingInterval) {
      clearInterval(this.pingInterval);
      this.pingInterval = null;
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
    return this.ws !== null && this.ws.readyState === WebSocket.OPEN;
  }
}

export const websocket = new WebSocketService();