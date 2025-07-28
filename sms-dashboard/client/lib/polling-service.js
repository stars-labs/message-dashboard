// Polling-based real-time service for Cloudflare Workers compatibility
export class PollingService {
  constructor() {
    this.pollingInterval = null;
    this.callbacks = new Map();
    this.isPolling = false;
    this.lastUpdateTime = null;
    this.pollIntervalMs = 5000; // 5 seconds
    this.token = null;
  }

  async connect(token) {
    console.log('[PollingService] Starting polling with token:', !!token);
    this.token = token;
    this.isPolling = true;
    this.startPolling();
    
    // Emit connected event
    this.handleMessage({
      type: 'connected',
      timestamp: new Date().toISOString()
    });
  }

  disconnect() {
    console.log('[PollingService] Stopping polling');
    this.isPolling = false;
    this.stopPolling();
  }

  async startPolling() {
    if (this.pollingInterval) return;

    // Initial poll
    await this.poll();

    // Set up interval
    this.pollingInterval = setInterval(async () => {
      if (this.isPolling) {
        await this.poll();
      }
    }, this.pollIntervalMs);
  }

  stopPolling() {
    if (this.pollingInterval) {
      clearInterval(this.pollingInterval);
      this.pollingInterval = null;
    }
  }

  async poll() {
    try {
      const baseUrl = import.meta.env.VITE_API_BASE_URL || 
        (typeof window !== 'undefined' ? window.location.origin : '');
      
      // Poll for updates since last update time
      const params = new URLSearchParams();
      if (this.lastUpdateTime) {
        params.set('since', this.lastUpdateTime);
      }
      
      const response = await fetch(`${baseUrl}/api/updates?${params}`, {
        headers: {
          'Authorization': `Bearer ${this.token}`,
          'Content-Type': 'application/json'
        }
      });

      if (!response.ok) {
        console.error('[PollingService] Poll failed:', response.status);
        return;
      }

      const data = await response.json();
      
      // Process updates
      if (data.updates && data.updates.length > 0) {
        for (const update of data.updates) {
          this.handleMessage(update);
        }
      }

      // Update last poll time
      this.lastUpdateTime = data.timestamp || new Date().toISOString();

      // Emit heartbeat
      this.handleMessage({
        type: 'heartbeat',
        timestamp: new Date().toISOString()
      });

    } catch (error) {
      console.error('[PollingService] Poll error:', error);
    }
  }

  handleMessage(message) {
    console.log('[PollingService] Message received:', message.type, message);
    
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

  // Compatibility methods to match SSE interface
  send(data) {
    console.warn('[PollingService] Send not supported in polling mode');
  }

  async request(type, data = {}) {
    console.warn('[PollingService] Use regular HTTP API calls instead');
    throw new Error('Polling does not support request-response pattern');
  }

  getConnectionType() {
    return 'polling';
  }

  // Make isConnected a property getter for compatibility
  get isConnected() {
    return this.isPolling;
  }
}

export const pollingService = new PollingService();