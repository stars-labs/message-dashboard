export class WebSocketRoom {
  constructor(state, env) {
    this.state = state;
    this.env = env;
    this.sessions = new Map(); // Client sessions
    this.daemons = new Map();  // Daemon connections
  }

  async fetch(request) {
    const url = new URL(request.url);
    
    // Check if this is a WebSocket upgrade request
    const upgradeHeader = request.headers.get('Upgrade');
    if (upgradeHeader === 'websocket') {
      return this.handleWebSocket(request);
    }
    
    switch (url.pathname) {
      case '/broadcast':
        return this.handleBroadcast(request);
      case '/ping':
        return new Response('pong', { status: 200 });
      default:
        return new Response('Not found', { status: 404 });
    }
  }

  async handleWebSocket(request) {
    try {
      const url = new URL(request.url);
      const upgradeHeader = request.headers.get('Upgrade');
      
      if (!upgradeHeader || upgradeHeader !== 'websocket') {
        return new Response('Expected Upgrade: websocket', { status: 426 });
      }

      // Create WebSocket pair
      const webSocketPair = new WebSocketPair();
      const [client, server] = Object.values(webSocketPair);

      // Accept the WebSocket connection immediately
      server.accept();

      const sessionId = crypto.randomUUID();
      const isDaemon = url.pathname === '/daemon-ws';
      
      if (isDaemon) {
        return this.handleDaemonConnection(sessionId, server, client);
      } else {
        return this.handleClientConnection(sessionId, server, client);
      }
    } catch (error) {
      return new Response('Internal Server Error: ' + error.message, { status: 500 });
    }
  }

  async handleClientConnection(sessionId, server, client) {
    // Handle incoming messages
    server.addEventListener('message', async (event) => {
      try {
        const message = JSON.parse(event.data);
        await this.handleClientMessage(sessionId, message);
      } catch (error) {
        server.send(JSON.stringify({
          type: 'error',
          message: 'Invalid message format: ' + error.message
        }));
      }
    });

    // Handle close event
    server.addEventListener('close', (event) => {
      this.sessions.delete(sessionId);
      this.broadcastUserStatus();
    });

    // Handle error event
    server.addEventListener('error', (error) => {
      console.error(`[WebSocketRoom] Client error:`, error);
    });

    // Store session
    this.sessions.set(sessionId, {
      websocket: server,
      user: null, // Will be set on authentication
      connectedAt: new Date().toISOString()
    });

    // Send initial connection message
    server.send(JSON.stringify({
      type: 'connected',
      sessionId: sessionId,
      timestamp: new Date().toISOString()
    }));

    // Return response with WebSocket client
    return new Response(null, {
      status: 101,
      webSocket: client,
    });
  }

  async handleDaemonConnection(sessionId, server, client) {
    console.log(`[WebSocketRoom] New daemon connection: ${sessionId}`);

    // Handle incoming messages from daemon
    server.addEventListener('message', async (event) => {
      try {
        const message = JSON.parse(event.data);
        await this.handleDaemonMessage(sessionId, message);
      } catch (error) {
        console.error(`[WebSocketRoom] Daemon message error:`, error);
        server.send(JSON.stringify({
          type: 'error',
          id: crypto.randomUUID(),
          timestamp: new Date().toISOString(),
          data: {
            code: 'INVALID_REQUEST',
            message: 'Invalid message format: ' + error.message
          }
        }));
      }
    });

    // Handle close event
    server.addEventListener('close', (event) => {
      console.log(`[WebSocketRoom] Daemon disconnected: ${sessionId}`);
      this.daemons.delete(sessionId);
    });

    // Handle error event
    server.addEventListener('error', (error) => {
      console.error(`[WebSocketRoom] Daemon error:`, error);
    });

    // Store daemon session (not authenticated yet)
    this.daemons.set(sessionId, {
      websocket: server,
      authenticated: false,
      connectedAt: new Date().toISOString(),
      device_id: null,
      daemon_version: null
    });

    // Send initial connection message
    server.send(JSON.stringify({
      type: 'connected',
      id: crypto.randomUUID(),
      timestamp: new Date().toISOString(),
      data: {
        sessionId: sessionId,
        message: 'Please authenticate with API key'
      }
    }));

    // Return response with WebSocket client
    return new Response(null, {
      status: 101,
      webSocket: client,
    });
  }

  async handleBroadcast(request) {
    try {
      const { type, data } = await request.json();
      
      console.log(`[WebSocketRoom] Received broadcast: ${type}, sessions: ${this.sessions.size}`);
      
      const message = JSON.stringify({
        type: type,
        data: data,
        timestamp: new Date().toISOString()
      });

      let sentCount = 0;
      this.sessions.forEach((session, sessionId) => {
        try {
          session.websocket.send(message);
          sentCount++;
          console.log(`[WebSocketRoom] Sent ${type} to session ${sessionId}`);
        } catch (error) {
          console.error(`[WebSocketRoom] Failed to send to session ${sessionId}:`, error);
        }
      });

      console.log(`[WebSocketRoom] Broadcast complete: sent to ${sentCount}/${this.sessions.size} sessions`);

      return new Response(JSON.stringify({ success: true, recipients: this.sessions.size, sent: sentCount }), {
        headers: { 'Content-Type': 'application/json' }
      });
    } catch (error) {
      return new Response(JSON.stringify({ error: error.message }), {
        status: 400,
        headers: { 'Content-Type': 'application/json' }
      });
    }
  }

  async handleClientMessage(sessionId, message) {
    const session = this.sessions.get(sessionId);
    if (!session) return;

    switch (message.type) {
      case 'ping':
        session.websocket.send(JSON.stringify({
          type: 'pong',
          timestamp: new Date().toISOString()
        }));
        break;
      
      case 'auth':
        // Handle authentication if user info provided in headers
        if (this.env && message.token) {
          // Note: This would need to be handled in the main worker
          // as Durable Objects don't have access to KV
          session.websocket.send(JSON.stringify({
            type: 'error',
            message: 'Authentication must be done via token in URL'
          }));
        }
        break;
      
      case 'subscribe':
        session.subscriptions = message.channels || ['messages', 'phones'];
        session.websocket.send(JSON.stringify({
          type: 'subscribed',
          channels: session.subscriptions
        }));
        break;

      case 'send_message':
        // Forward message send request to daemon
        await this.forwardToAuthenticatedDaemon(message);
        break;
      
      default:
        session.websocket.send(JSON.stringify({
          type: 'error',
          message: 'Unknown message type'
        }));
    }
  }

  async handleDaemonMessage(sessionId, message) {
    const daemon = this.daemons.get(sessionId);
    if (!daemon) return;

    console.log(`[WebSocketRoom] Daemon message: ${message.type} from ${sessionId}`);

    switch (message.type) {
      case 'auth':
        await this.handleDaemonAuth(sessionId, message);
        break;

      case 'phone_update':
        if (daemon.authenticated) {
          const phones = message.data.phones;
          console.log(`[WebSocketRoom] Received phone_update with ${phones.length} phones`);
          
          // For now, just broadcast to clients
          // The daemon should also call the HTTP API to persist phones
          await this.broadcastToClients('phones:updated', phones);
          
          // Send acknowledgment to daemon
          daemon.websocket.send(JSON.stringify({
            type: 'ack',
            id: crypto.randomUUID(),
            timestamp: new Date().toISOString(),
            data: {
              request_id: message.id,
              message: 'Phone update received and broadcast'
            }
          }));
        }
        break;

      case 'message_upload':
        if (daemon.authenticated) {
          const messages = message.data.messages;
          console.log(`[WebSocketRoom] Received message_upload with ${messages.length} messages`);
          
          // For now, just broadcast to clients
          // The daemon should also call the HTTP API to persist messages
          await this.broadcastToClients('messages:bulk_created', messages);
          
          // Send acknowledgment to daemon
          daemon.websocket.send(JSON.stringify({
            type: 'ack',
            id: crypto.randomUUID(),
            timestamp: new Date().toISOString(),
            data: {
              request_id: message.id,
              message: 'Messages received and broadcast'
            }
          }));
        }
        break;

      case 'send_result':
        if (daemon.authenticated) {
          // Broadcast send result to all clients
          await this.broadcastToClients('message:sent', message.data);
        }
        break;

      case 'heartbeat':
        if (daemon.authenticated) {
          daemon.websocket.send(JSON.stringify({
            type: 'heartbeat_response',
            id: crypto.randomUUID(),
            timestamp: new Date().toISOString(),
            data: {
              server_time: new Date().toISOString(),
              next_heartbeat: 60
            }
          }));
        }
        break;

      default:
        daemon.websocket.send(JSON.stringify({
          type: 'error',
          id: crypto.randomUUID(),
          timestamp: new Date().toISOString(),
          data: {
            code: 'INVALID_REQUEST',
            message: 'Unknown message type: ' + message.type
          }
        }));
    }
  }

  async handleDaemonAuth(sessionId, message) {
    const daemon = this.daemons.get(sessionId);
    if (!daemon) return;

    const { api_key, daemon_version, device_id } = message.data;

    // Validate API key (this should match the one in Wrangler secrets)
    const expectedKey = '4025b019988238528f1fd5e909d0363c46e4e48490ea5045a9a490c259071cba';
    
    if (api_key === expectedKey) {
      daemon.authenticated = true;
      daemon.daemon_version = daemon_version;
      daemon.device_id = device_id;

      console.log(`[WebSocketRoom] Daemon authenticated: ${device_id} v${daemon_version}`);

      daemon.websocket.send(JSON.stringify({
        type: 'auth_response',
        id: crypto.randomUUID(),
        timestamp: new Date().toISOString(),
        data: {
          success: true,
          message: 'Authenticated successfully',
          daemon_id: sessionId
        }
      }));
    } else {
      console.log(`[WebSocketRoom] Daemon authentication failed: invalid API key`);
      
      daemon.websocket.send(JSON.stringify({
        type: 'auth_response',
        id: crypto.randomUUID(),
        timestamp: new Date().toISOString(),
        data: {
          success: false,
          message: 'Authentication failed: invalid API key'
        }
      }));

      // Close connection after failed auth
      daemon.websocket.close(1008, 'Authentication failed');
      this.daemons.delete(sessionId);
    }
  }

  async forwardToAuthenticatedDaemon(message) {
    // Find authenticated daemon
    let authenticatedDaemon = null;
    for (const [sessionId, daemon] of this.daemons) {
      if (daemon.authenticated) {
        authenticatedDaemon = daemon;
        break;
      }
    }

    if (authenticatedDaemon) {
      console.log(`[WebSocketRoom] Forwarding send_message to daemon`);
      authenticatedDaemon.websocket.send(JSON.stringify({
        type: 'send_message',
        id: crypto.randomUUID(),
        timestamp: new Date().toISOString(),
        data: message.data
      }));
    } else {
      console.error(`[WebSocketRoom] No authenticated daemon available for message sending`);
      // Could broadcast error to clients here
    }
  }

  async broadcastToClients(type, data) {
    const message = JSON.stringify({
      type: type,
      data: data,
      timestamp: new Date().toISOString()
    });

    let sentCount = 0;
    this.sessions.forEach((session, sessionId) => {
      try {
        session.websocket.send(message);
        sentCount++;
      } catch (error) {
        console.error(`[WebSocketRoom] Failed to send to client ${sessionId}:`, error);
      }
    });

    console.log(`[WebSocketRoom] Broadcast ${type} to ${sentCount} clients`);
  }

  broadcastUserStatus() {
    const activeUsers = Array.from(this.sessions.values()).map(session => ({
      email: session.user.email,
      connectedAt: session.connectedAt
    }));

    const message = JSON.stringify({
      type: 'activeUsers',
      data: activeUsers
    });

    this.sessions.forEach((session) => {
      try {
        session.websocket.send(message);
      } catch (error) {
      }
    });
  }

  extractVerificationCode(content) {
    if (!content) return null;
    
    // Common verification code patterns
    const patterns = [
      /(\d{4,8})\s*(?:is|为|是|为您的|是您的|是你的).*(?:验证码|校验码|确认码|code|verification)/i,
      /(?:验证码|校验码|确认码|code|verification).*?[:：]?\s*(\d{4,8})/i,
      /【[^】]+】.*?(\d{4,8})/,
      /\[.*?\].*?(\d{4,8})/,
      /^(\d{4,8})$/,
      /SMS Code:\s*(\d{4,8})/i,
      /Your.*?code.*?is.*?(\d{4,8})/i
    ];
    
    for (const pattern of patterns) {
      const match = content.match(pattern);
      if (match && match[1]) {
        return match[1];
      }
    }
    
    return null;
  }
}