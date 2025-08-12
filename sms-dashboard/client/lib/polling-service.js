// Simple HTTP Polling service for real-time updates
export class PollingService {
  constructor() {
    this.pollTimeout = null;
    this.callbacks = new Map();
    this.isPolling = false;
    this.pollIntervalMs = 2000; // Poll every 2 seconds
    this.token = null;
    
    // Track the latest message ID we've seen
    this.latestMessageId = null;
    this.latestMessageTimestamp = null;
  }

  async connect(token) {
    console.debug('[PollingService] Starting polling with token:', !!token);
    this.token = token;
    this.isPolling = true;
    
    // Emit connected event
    this.emit('connected', {
      type: 'connected',
      timestamp: new Date().toISOString()
    });
    
    // Start polling loop
    this.startPolling();
  }

  disconnect() {
    console.debug('[PollingService] Stopping polling');
    this.isPolling = false;
    this.stopPolling();
    
    // Emit disconnected event
    this.emit('disconnected', {
      type: 'disconnected',
      timestamp: new Date().toISOString()
    });
  }

  async startPolling() {
    if (this.pollTimeout) return;

    const pollLoop = async () => {
      if (!this.isPolling) return;
      
      try {
        await this.poll();
      } catch (error) {
        console.error('[PollingService] Poll error:', error);
      }
      
      // Schedule next poll
      if (this.isPolling) {
        this.pollTimeout = setTimeout(pollLoop, this.pollIntervalMs);
      }
    };

    // Start polling immediately
    pollLoop();
  }

  stopPolling() {
    if (this.pollTimeout) {
      clearTimeout(this.pollTimeout);
      this.pollTimeout = null;
    }
  }

  async poll() {
    const baseUrl = import.meta.env.VITE_API_BASE_URL || 
      (typeof window !== 'undefined' ? window.location.origin : '');
    
    // Build query params
    const params = new URLSearchParams();
    
    // Only send the latest message info if we have it
    if (this.latestMessageId) {
      params.set('latest_message_id', this.latestMessageId);
    }
    if (this.latestMessageTimestamp) {
      params.set('latest_timestamp', this.latestMessageTimestamp);
    }
    
    const queryString = params.toString();
    const url = `${baseUrl}/api/updates${queryString ? '?' + queryString : ''}`;
    
    console.debug(`[PollingService] Polling: ${url}`);
    
    const response = await fetch(url, {
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
    if (data.updates && Array.isArray(data.updates)) {
      console.debug(`[PollingService] Received ${data.updates.length} update(s)`);
      
      for (const update of data.updates) {
        // Track latest message info from bulk_created events
        if (update.type === 'messages:bulk_created' && update.data && update.data.length > 0) {
          // Sort messages by timestamp to find the latest
          const sortedMessages = update.data.sort((a, b) => 
            new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime()
          );
          
          const latestMessage = sortedMessages[0];
          if (latestMessage) {
            // Update our tracking
            this.latestMessageId = latestMessage.id;
            this.latestMessageTimestamp = latestMessage.timestamp;
            console.debug(`[PollingService] Updated latest message tracking:`, {
              id: this.latestMessageId,
              timestamp: this.latestMessageTimestamp
            });
          }
        }
        
        // Emit the update
        this.emit(update.type, update);
      }
    }
    
    // Emit heartbeat
    this.emit('heartbeat', {
      type: 'heartbeat',
      timestamp: new Date().toISOString()
    });
  }

  emit(event, data) {
    // Emit to specific event listeners
    const callbacks = this.callbacks.get(event);
    if (callbacks) {
      callbacks.forEach(callback => {
        try {
          callback(data);
        } catch (error) {
          console.error(`[PollingService] Error in callback for ${event}:`, error);
        }
      });
    }

    // Emit to wildcard listeners
    const wildcardCallbacks = this.callbacks.get('*');
    if (wildcardCallbacks) {
      wildcardCallbacks.forEach(callback => {
        try {
          callback(data);
        } catch (error) {
          console.error('[PollingService] Error in wildcard callback:', error);
        }
      });
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

  // Compatibility methods
  send(data) {
    console.warn('[PollingService] Send not supported in polling mode');
  }

  async request(type, data = {}) {
    console.warn('[PollingService] Request not supported in polling mode');
    throw new Error('Polling does not support request-response pattern');
  }

  getConnectionType() {
    return 'polling';
  }

  get isConnected() {
    return this.isPolling;
  }
  
  // Method to update latest message tracking externally
  updateLatestMessage(messageId, timestamp) {
    this.latestMessageId = messageId;
    this.latestMessageTimestamp = timestamp;
    console.debug('[PollingService] External update of latest message:', {
      id: messageId,
      timestamp: timestamp
    });
  }
}

export const pollingService = new PollingService();