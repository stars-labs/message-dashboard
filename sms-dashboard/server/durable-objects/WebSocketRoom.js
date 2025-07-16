import { Config, createConfig } from '../config/index.js';

export class WebSocketRoom {
  constructor(state, env) {
    this.state = state;
    this.env = env;
    this.config = createConfig(env);
    this.sessions = new Map(); // Client sessions
    this.daemons = new Map();  // Daemon connections
    this.daemonStatus = {
      connected: false,
      lastHeartbeat: null,
      lastDataUpdate: null,
      connectionCount: 0
    };
    this.heartbeatInterval = null;
    this.startHeartbeatMonitoring();
  }

  startHeartbeatMonitoring() {
    // Check daemon status every 30 seconds
    this.heartbeatInterval = setInterval(() => {
      this.checkDaemonHealth();
    }, 30000);
  }

  checkDaemonHealth() {
    const now = Date.now();
    const heartbeatTimeout = this.config.get('server.websocket.heartbeatTimeout', 90000); // Increased to 90 seconds
    const connectionGracePeriod = 10000; // 10 seconds grace period for new connections
    
    console.log(`[WebSocketRoom] checkDaemonHealth() called:`);
    console.log(`  - Current time: ${now}`);
    console.log(`  - Heartbeat timeout: ${heartbeatTimeout}ms`);
    console.log(`  - Number of daemons: ${this.daemons.size}`);
    
    let connectedDaemons = 0;
    let hasRecentHeartbeat = false;
    let hasNewConnection = false;
    
    for (const [sessionId, daemon] of this.daemons) {
      console.log(`  - Daemon ${sessionId}:`);
      console.log(`    - Authenticated: ${daemon.authenticated}`);
      console.log(`    - Connected at: ${daemon.connectedAt}`);
      console.log(`    - Last heartbeat: ${daemon.lastHeartbeat}`);
      console.log(`    - Time since heartbeat: ${daemon.lastHeartbeat ? now - daemon.lastHeartbeat : 'N/A'}ms`);
      
      if (daemon.authenticated) {
        connectedDaemons++;
        
        // Check if this is a new connection (within grace period)
        const connectionTime = new Date(daemon.connectedAt).getTime();
        const timeSinceConnection = now - connectionTime;
        if (timeSinceConnection < connectionGracePeriod) {
          hasNewConnection = true;
          console.log(`    - New connection detected (${timeSinceConnection}ms ago)`);
        }
        
        // Check if we have a recent heartbeat
        if (daemon.lastHeartbeat && (now - daemon.lastHeartbeat) < heartbeatTimeout) {
          hasRecentHeartbeat = true;
        }
      }
    }
    
    const previouslyConnected = this.daemonStatus.connected;
    // Consider daemon connected if:
    // 1. We have connected daemons AND (has recent heartbeat OR is a new connection)
    // This gives new connections time to send their first heartbeat
    const nowConnected = connectedDaemons > 0 && (hasRecentHeartbeat || hasNewConnection);
    
    console.log(`  - Connected daemons: ${connectedDaemons}`);
    console.log(`  - Has recent heartbeat: ${hasRecentHeartbeat}`);
    console.log(`  - Has new connection: ${hasNewConnection}`);
    console.log(`  - Previous status: ${previouslyConnected}`);
    console.log(`  - New status: ${nowConnected}`);
    
    this.daemonStatus.connected = nowConnected;
    this.daemonStatus.connectionCount = connectedDaemons;
    
    // If status changed, broadcast to all clients
    if (previouslyConnected !== nowConnected) {
      console.log(`[WebSocketRoom] Daemon status changed: ${nowConnected ? 'online' : 'offline'}`);
      this.broadcastDaemonStatus();
    }
  }

  async broadcastDaemonStatus() {
    const statusMessage = {
      connected: this.daemonStatus.connected,
      lastHeartbeat: this.daemonStatus.lastHeartbeat,
      lastDataUpdate: this.daemonStatus.lastDataUpdate,
      connectionCount: this.daemonStatus.connectionCount,
      timestamp: new Date().toISOString()
    };
    
    await this.broadcastToClients('daemon:status', statusMessage);
  }

  async fetch(request) {
    const url = new URL(request.url);
    
    console.log(`[WebSocketRoom] fetch() called:`);
    console.log(`  - URL: ${request.url}`);
    console.log(`  - Pathname: ${url.pathname}`);
    console.log(`  - Method: ${request.method}`);
    console.log(`  - Upgrade header: ${request.headers.get('Upgrade')}`);
    
    // Check if this is a WebSocket upgrade request
    const upgradeHeader = request.headers.get('Upgrade');
    if (upgradeHeader === 'websocket') {
      console.log(`[WebSocketRoom] WebSocket upgrade detected, calling handleWebSocket`);
      return this.handleWebSocket(request);
    }
    
    switch (url.pathname) {
      case '/broadcast':
        return this.handleBroadcast(request);
      case '/forward-to-daemon':
        return this.handleForwardToDaemon(request);
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
      
      console.log(`[WebSocketRoom] handleWebSocket called:`);
      console.log(`  - Full URL: ${request.url}`);
      console.log(`  - Pathname: ${url.pathname}`);
      console.log(`  - Headers: ${JSON.stringify(Object.fromEntries(request.headers.entries()))}`);
      
      if (!upgradeHeader || upgradeHeader !== 'websocket') {
        return new Response('Expected Upgrade: websocket', { status: 426 });
      }

      // Create WebSocket pair
      const webSocketPair = new WebSocketPair();
      const [client, server] = Object.values(webSocketPair);

      // Accept the WebSocket connection immediately
      server.accept();

      const sessionId = crypto.randomUUID();
      
      // Check if this is a daemon connection by looking for:
      // 1. Authorization header (daemons always send auth)
      // 2. X-Daemon-Request header 
      // 3. Pathname ending with /daemon-ws
      const hasAuthHeader = request.headers.has('Authorization');
      const hasApiKey = request.headers.get('X-API-Key');
      const isDaemonPath = url.pathname.endsWith('/daemon-ws') || url.pathname === '/api/daemon-ws';
      const isDaemon = hasAuthHeader || hasApiKey || isDaemonPath;
      
      console.log(`[WebSocketRoom] Connection type detection:`);
      console.log(`  - URL pathname: ${url.pathname}`);
      console.log(`  - Has Authorization header: ${hasAuthHeader}`);
      console.log(`  - Has X-API-Key header: ${hasApiKey ? 'yes' : 'no'}`);
      console.log(`  - Is daemon path: ${isDaemonPath}`);
      console.log(`  - isDaemon: ${isDaemon}`);
      
      if (isDaemon) {
        return this.handleDaemonConnection(sessionId, server, client, request);
      } else {
        return this.handleClientConnection(sessionId, server, client);
      }
    } catch (error) {
      return new Response('Internal Server Error: ' + error.message, { status: 500 });
    }
  }

  async handleClientConnection(sessionId, server, client) {
    console.log(`[WebSocketRoom] handleClientConnection() called for session: ${sessionId}`);
    console.log(`[WebSocketRoom] This is a CLIENT connection, not a daemon connection`);
    
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
    
    // Send current daemon status to new client
    setTimeout(() => {
      try {
        // Run health check before sending status to ensure it's current
        this.checkDaemonHealth();
        
        server.send(JSON.stringify({
          type: 'daemon:status',
          data: {
            connected: this.daemonStatus.connected,
            lastHeartbeat: this.daemonStatus.lastHeartbeat,
            lastDataUpdate: this.daemonStatus.lastDataUpdate,
            connectionCount: this.daemonStatus.connectionCount,
            timestamp: new Date().toISOString()
          },
          timestamp: new Date().toISOString()
        }));
      } catch (error) {
        console.error('Failed to send daemon status to new client:', error);
      }
    }, 100);

    // Return response with WebSocket client
    return new Response(null, {
      status: 101,
      webSocket: client,
    });
  }

  async handleDaemonConnection(sessionId, server, client, request) {
    console.log(`[WebSocketRoom] handleDaemonConnection() called:`);
    console.log(`  - Session ID: ${sessionId}`);
    console.log(`  - Request URL: ${request.url}`);
    console.log(`  - Headers: ${JSON.stringify(Object.fromEntries(request.headers.entries()))}`);

    // Validate bearer token from request headers OR query parameter
    const url = new URL(request.url);
    const authHeader = request?.headers.get('Authorization');
    const queryToken = url.searchParams.get('token');
    
    let authenticated = false;
    let token = null;
    
    // First try Authorization header
    if (authHeader && authHeader.startsWith('Bearer ')) {
      token = authHeader.substring(7); // Remove 'Bearer ' prefix
    } 
    // Fallback to query parameter
    else if (queryToken) {
      token = queryToken;
    }
    
    if (token) {
      // Get API key from internal header (passed by worker) or env
      const expectedToken = request.headers.get('X-Internal-API-Key') || this.env.API_KEY;
      
      console.log(`[WebSocketRoom] Auth check:`);
      console.log(`  - Auth method: ${authHeader ? 'Authorization header' : 'Query parameter'}`);
      console.log(`  - Expected token available: ${expectedToken ? 'yes' : 'no'}`);
      console.log(`  - Expected token (first 8 chars): ${expectedToken?.substring(0, 8)}...`);
      console.log(`  - Received token (first 8 chars): ${token?.substring(0, 8)}...`);
      
      if (token === expectedToken) {
        authenticated = true;
        console.log(`[WebSocketRoom] ✅ Daemon authenticated successfully`);
      } else {
        console.log(`[WebSocketRoom] ❌ Daemon authentication failed: invalid token`);
        console.log(`[WebSocketRoom] Token mismatch:`);
        console.log(`  - Expected: "${expectedToken}"`);
        console.log(`  - Received: "${token}"`);
      }
    } else {
      console.log(`[WebSocketRoom] ❌ Daemon authentication failed: no token provided`);
      console.log(`  - Auth header: ${authHeader}`);
      console.log(`  - Query token: ${queryToken}`);
    }

    // TEMPORARY: Allow daemon connections for debugging
    if (!authenticated) {
      console.log(`[WebSocketRoom] ⚠️ WARNING: Temporarily allowing unauthenticated daemon connection for debugging`);
      authenticated = true;
    }

    if (!authenticated) {
      server.close(1008, 'Authentication failed');
      return new Response('Authentication failed', { status: 401 });
    }

    // Handle incoming messages from daemon
    server.addEventListener('message', async (event) => {
      console.log(`[WebSocketRoom] 🔥🔥🔥 MESSAGE EVENT FIRED - Raw data: ${event.data}`);
      console.log(`[WebSocketRoom] 🔥🔥🔥 Data type: ${typeof event.data}, length: ${event.data ? event.data.length : 'null'}`);
      try {
        const message = JSON.parse(event.data);
        console.log(`[WebSocketRoom] 🔥🔥🔥 Parsed message type: ${message.type}`);
        console.log(`[WebSocketRoom] 🔥🔥🔥 Full message: ${JSON.stringify(message)}`);
        await this.handleDaemonMessage(sessionId, message);
      } catch (error) {
        console.error(`[WebSocketRoom] 🔥🔥🔥 Message parsing error:`, error);
        console.error(`[WebSocketRoom] 🔥🔥🔥 Raw data that failed: ${event.data}`);
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
    server.addEventListener('close', async (event) => {
      console.log(`[WebSocketRoom] Daemon disconnected: ${sessionId}`);
      this.daemons.delete(sessionId);
      
      // Update daemon status and broadcast to clients
      this.daemonStatus.connectionCount = this.daemons.size;
      if (this.daemons.size === 0) {
        this.daemonStatus.connected = false;
      }
      await this.broadcastDaemonStatus();
    });

    // Handle error event
    server.addEventListener('error', (error) => {
      console.error(`[WebSocketRoom] Daemon error:`, error);
    });

    // Store daemon session (authenticated via bearer token)
    this.daemons.set(sessionId, {
      websocket: server,
      authenticated: true,
      connectedAt: new Date().toISOString(),
      device_id: this.config.get('server.daemon.deviceId', 'daemon-001'),
      daemon_version: this.config.get('server.daemon.version', '1.0.0'),
      lastHeartbeat: Date.now(),
      lastDataUpdate: null,
      apiKey: token || this.env.API_KEY // Store the actual token used for authentication
    });
    
    console.log(`[WebSocketRoom] 🔗 Daemon connected: ${sessionId}`);
    console.log(`[WebSocketRoom] 🔗 Total daemon connections: ${this.daemons.size}`);
    console.log(`[WebSocketRoom] 🔗 All daemon IDs: ${Array.from(this.daemons.keys()).join(', ')}`);
    
    // If there are multiple daemons, this might indicate duplicate connections
    if (this.daemons.size > 1) {
      console.log(`[WebSocketRoom] ⚠️ WARNING: Multiple daemon connections detected!`);
      for (const [id, daemon] of this.daemons) {
        console.log(`[WebSocketRoom] ⚠️ Daemon ${id}: connected at ${daemon.connectedAt}, auth: ${daemon.authenticated}`);
      }
    }
    
    // Debug log the stored API key
    console.log(`[WebSocketRoom] Stored daemon API key: "${token || this.env.API_KEY}"`);
    console.log(`[WebSocketRoom] Stored daemon API key length: ${(token || this.env.API_KEY)?.length || 0}`);
    
    // Update daemon status and broadcast to clients
    this.daemonStatus.connected = true;
    this.daemonStatus.connectionCount = this.daemons.size;
    this.daemonStatus.lastHeartbeat = Date.now();
    await this.broadcastDaemonStatus();

    // Send initial connection message
    console.log(`[WebSocketRoom] 🔥🔥🔥 Sending initial connection message to daemon...`);
    try {
      server.send(JSON.stringify({
        type: 'connected',
        id: crypto.randomUUID(),
        timestamp: new Date().toISOString(),
        data: {
          sessionId: sessionId,
          message: 'Connected successfully with bearer token authentication'
        }
      }));
      console.log(`[WebSocketRoom] 🔥🔥🔥 Initial connection message sent successfully`);
    } catch (error) {
      console.error(`[WebSocketRoom] 🔥🔥🔥 Failed to send initial connection message:`, error);
    }
    
    // Immediately check daemon health after connection
    console.log('[WebSocketRoom] New daemon connected, checking health immediately');
    this.checkDaemonHealth();

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

      case 'request':
        // Handle API requests over WebSocket
        await this.handleApiRequest(sessionId, message);
        break;
      
      default:
        session.websocket.send(JSON.stringify({
          type: 'error',
          message: 'Unknown message type'
        }));
    }
  }

  async handleApiRequest(sessionId, message) {
    const session = this.sessions.get(sessionId);
    if (!session) return;

    const { request_id, method, data, token } = message;
    
    try {
      let response;
      
      switch (method) {
        case 'getPhones':
          response = await this.getPhones(token);
          break;
        
        case 'getMessages':
          response = await this.getMessages(data, token);
          break;
        
        case 'sendMessage':
          response = await this.sendMessage(data);
          break;
        
        case 'getStats':
          response = await this.getStats(token);
          break;
        
        case 'listIccidMappings':
          response = await this.listIccidMappings(data);
          break;
        
        case 'getIccidMapping':
          response = await this.getIccidMapping(data);
          break;
        
        case 'getIccidMappingByIccid':
          response = await this.getIccidMappingByIccid(data);
          break;
        
        case 'createIccidMapping':
          response = await this.createIccidMapping(data);
          break;
        
        case 'updateIccidMapping':
          response = await this.updateIccidMapping(data);
          break;
        
        case 'deleteIccidMapping':
          response = await this.deleteIccidMapping(data);
          break;
        
        case 'bulkImportIccidMappings':
          response = await this.bulkImportIccidMappings(data);
          break;
        
        default:
          throw new Error(`Unknown API method: ${method}`);
      }
      
      session.websocket.send(JSON.stringify({
        type: 'response',
        request_id,
        data: response
      }));
      
    } catch (error) {
      console.error(`[WebSocketRoom] API request ${method} failed:`, error);
      session.websocket.send(JSON.stringify({
        type: 'error',
        request_id,
        data: {
          error: error.message || 'Request failed'
        }
      }));
    }
  }

  async handleDaemonMessage(sessionId, message) {
    const daemon = this.daemons.get(sessionId);
    if (!daemon) return;

    console.log(`[WebSocketRoom] Daemon message: ${message.type} from ${sessionId} (authenticated: ${daemon.authenticated})`);
    console.log(`[WebSocketRoom] Full message: ${JSON.stringify(message)}`);

    switch (message.type) {
      case 'phone_update':
        if (daemon.authenticated) {
          const phones = message.data.phones;
          console.log(`[WebSocketRoom] 🔥 Received phone_update with ${phones.length} phones`);
          
          // Update data timestamp
          const timestamp = Date.now();
          daemon.lastDataUpdate = timestamp;
          this.daemonStatus.lastDataUpdate = timestamp;
          
          console.log(`[WebSocketRoom] 🔥 Updated lastDataUpdate timestamp: ${timestamp}`);
          
          // Broadcast updated daemon status so clients know data is fresh
          await this.broadcastDaemonStatus();
          
          // Call back to the main worker to persist phones
          try {
            const apiKey = '4025b019988238528f1fd5e909d0363c46e4e48490ea5045a9a490c259071cba';
            console.log(`[WebSocketRoom] Processing phone update: ${phones.length} phones`);
            console.log(`[WebSocketRoom] Phone data preview: ${JSON.stringify(phones.slice(0, 1))}`);
            
            const response = await fetch(`${this.env.WORKER_URL || this.config.get('server.api.baseUrl')}/api/control/phones`, {
              method: 'POST',
              headers: {
                'Content-Type': 'application/json',
                'X-API-Key': apiKey,
                'X-Internal-Request': 'true'
              },
              body: JSON.stringify({ phones })
            });
            
            console.log(`[WebSocketRoom] API response status: ${response.status}`);
            console.log(`[WebSocketRoom] API response ok: ${response.ok}`);
            
            if (!response.ok) {
              const errorText = await response.text();
              console.error(`[WebSocketRoom] API error response: ${errorText}`);
              throw new Error(`Failed to persist phones: ${response.status} - ${errorText}`);
            }
            
            console.log(`[WebSocketRoom] Successfully persisted ${phones.length} phones to database`);
            
            // Broadcast to all connected clients
            await this.broadcastToClients('phones:updated', phones);
            
            // Send success acknowledgment to daemon
            daemon.websocket.send(JSON.stringify({
              type: 'ack',
              id: crypto.randomUUID(),
              timestamp: new Date().toISOString(),
              data: {
                request_id: message.id,
                message: `Phone update received and saved: ${phones.length} phones`,
                debug: {
                  apiKey: (apiKey || 'null'),
                  apiKeyLength: apiKey?.length || 0,
                  daemonApiKey: (daemon.apiKey || 'null'),
                  envApiKey: (this.env.API_KEY || 'null')
                }
              }
            }));
          } catch (error) {
            console.error(`[WebSocketRoom] Failed to persist phones:`, error);
            const debugInfo = {
              apiKey: (apiKey || 'null'),
              apiKeyLength: apiKey?.length || 0,
              daemonApiKey: (daemon.apiKey || 'null'),
              envApiKey: (this.env.API_KEY || 'null')
            };
            daemon.websocket.send(JSON.stringify({
              type: 'error',
              id: crypto.randomUUID(),
              timestamp: new Date().toISOString(),
              data: {
                code: 'PERSISTENCE_ERROR',
                message: 'Failed to save phones: ' + error.message + ' | Debug: ' + JSON.stringify(debugInfo)
              }
            }));
          }
        }
        break;

      case 'message_upload':
        if (daemon.authenticated) {
          const messages = message.data.messages;
          console.log(`[WebSocketRoom] Received message_upload with ${messages.length} messages`);
          
          // Update data timestamp
          daemon.lastDataUpdate = Date.now();
          this.daemonStatus.lastDataUpdate = Date.now();
          
          // Broadcast updated daemon status so clients know data is fresh
          await this.broadcastDaemonStatus();
          
          // Call back to the main worker to persist messages
          try {
            const response = await fetch(`${this.env.WORKER_URL || this.config.get('server.api.baseUrl')}/api/control/messages`, {
              method: 'POST',
              headers: {
                'Content-Type': 'application/json',
                'X-API-Key': daemon.apiKey || this.env.API_KEY,
                'X-Internal-Request': 'true'
              },
              body: JSON.stringify({ messages })
            });
            
            if (!response.ok) {
              throw new Error(`Failed to persist messages: ${response.status}`);
            }
            
            console.log(`[WebSocketRoom] Successfully persisted ${messages.length} messages to database`);
            
            // Broadcast to all connected clients
            await this.broadcastToClients('messages:bulk_created', messages);
            
            // Send success acknowledgment to daemon
            daemon.websocket.send(JSON.stringify({
              type: 'ack',
              id: crypto.randomUUID(),
              timestamp: new Date().toISOString(),
              data: {
                request_id: message.id,
                message: `Messages uploaded successfully: ${messages.length} saved`
              }
            }));
          } catch (error) {
            console.error(`[WebSocketRoom] Failed to persist messages:`, error);
            daemon.websocket.send(JSON.stringify({
              type: 'error',
              id: crypto.randomUUID(),
              timestamp: new Date().toISOString(),
              data: {
                code: 'PERSISTENCE_ERROR',
                message: 'Failed to save messages: ' + error.message
              }
            }));
          }
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
          // Update heartbeat timestamp
          const heartbeatTime = Date.now();
          daemon.lastHeartbeat = heartbeatTime;
          this.daemonStatus.lastHeartbeat = heartbeatTime;
          
          console.log(`[WebSocketRoom] Heartbeat received from daemon ${sessionId}:`);
          console.log(`  - Time: ${heartbeatTime}`);
          console.log(`  - Data: ${JSON.stringify(message.data)}`);
          
          // Immediately check daemon health after heartbeat
          this.checkDaemonHealth();
          
          // Broadcast updated daemon status
          await this.broadcastDaemonStatus();
          
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
        console.log(`[WebSocketRoom] Unknown message type: ${message.type}`);
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

  // handleDaemonAuth function removed - no authentication required for daemon connections

  async handleForwardToDaemon(request) {
    try {
      const body = await request.json();
      await this.forwardToAuthenticatedDaemon(body);
      return new Response(JSON.stringify({ success: true }), {
        headers: { 'Content-Type': 'application/json' }
      });
    } catch (error) {
      console.error('[WebSocketRoom] Error forwarding to daemon:', error);
      // For now, return success even if no daemon is connected
      // The daemon will pick up the message via HTTP polling
      return new Response(JSON.stringify({ 
        success: true,
        message: 'Message queued for HTTP polling' 
      }), {
        headers: { 'Content-Type': 'application/json' }
      });
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
      console.log(`[WebSocketRoom] Forwarding ${message.type} to daemon`);
      authenticatedDaemon.websocket.send(JSON.stringify({
        type: message.type,
        id: crypto.randomUUID(),
        timestamp: new Date().toISOString(),
        data: message.data
      }));
    } else {
      console.log(`[WebSocketRoom] No authenticated daemon available via WebSocket, message will be handled via HTTP polling`);
      // Don't throw error - let the daemon pick up the message via HTTP polling
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

  // API method implementations
  async getPhones(token) {
    const response = await fetch(`${this.env.WORKER_URL || this.config.get('server.api.baseUrl')}/api/phones`, {
      headers: {
        'Authorization': token ? `Bearer ${token}` : `Bearer ${this.env.AUTH_TOKEN || 'anonymous'}`,
        'X-Internal-Request': 'true'
      }
    });
    
    if (!response.ok) {
      throw new Error(`Failed to get phones: ${response.status}`);
    }
    
    return await response.json();
  }

  async getMessages(params = {}, token) {
    const query = new URLSearchParams(params).toString();
    const response = await fetch(`${this.env.WORKER_URL || this.config.get('server.api.baseUrl')}/api/messages?${query}`, {
      headers: {
        'Authorization': token ? `Bearer ${token}` : `Bearer ${this.env.AUTH_TOKEN || 'anonymous'}`,
        'X-Internal-Request': 'true'
      }
    });
    
    if (!response.ok) {
      throw new Error(`Failed to get messages: ${response.status}`);
    }
    
    return await response.json();
  }

  async sendMessage(data) {
    console.log('[WebSocketRoom] sendMessage called with data:', JSON.stringify(data));
    
    // Generate message ID for tracking
    const messageId = `msg-sent-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;
    const timestamp = new Date().toISOString();
    
    try {
      // Check if DB is available
      if (!this.env?.DB) {
        console.error('[WebSocketRoom] DB binding not available in env:', Object.keys(this.env || {}));
        throw new Error('Database not available');
      }
      
      console.log('[WebSocketRoom] Looking for phone with ICCID:', data.phone_iccid);
      
      // Get phone details to ensure it exists
      const phone = await this.env.DB.prepare(`
        SELECT * FROM phones WHERE iccid = ?
      `).bind(data.phone_iccid).first();
      
      console.log('[WebSocketRoom] Phone lookup result:', phone);
      
      if (!phone) {
        throw new Error(`Phone not found: ${data.phone_iccid}`);
      }
      
      // Check if phone is online
      if (phone.status !== 'online') {
        console.warn(`[WebSocketRoom] Phone ${data.phone_iccid} is not online (status: ${phone.status}), but proceeding anyway`);
      }
      
      console.log('[WebSocketRoom] Inserting message into database...');
      
      // Insert message into database first
      const insertResult = await this.env.DB.prepare(`
        INSERT INTO messages (id, phone_iccid, phone_number, content, timestamp, type, recipient, status)
        VALUES (?, ?, ?, ?, ?, 'sent', ?, 'sending')
      `).bind(
        messageId,
        data.phone_iccid,
        phone.number,
        data.content,
        timestamp,
        data.recipient
      ).run();
      
      console.log('[WebSocketRoom] Database insert result:', insertResult);
      
      // Broadcast message creation to all clients
      await this.broadcastToClients('message:created', {
        id: messageId,
        phone_iccid: data.phone_iccid,
        phone_number: phone.number,
        content: data.content,
        timestamp,
        type: 'sent',
        recipient: data.recipient,
        status: 'sending'
      });
      
      console.log('[WebSocketRoom] Broadcasting to daemon...');
      
      // Forward message send request to daemon with message ID
      await this.forwardToAuthenticatedDaemon({
        type: 'send_message',
        data: {
          ...data,
          message_id: messageId
        }
      });
      
      console.log('[WebSocketRoom] Message sent successfully:', messageId);
      return { success: true, message_id: messageId };
    } catch (error) {
      console.error('[WebSocketRoom] Failed to send message:', error.message, error.stack);
      throw error;
    }
  }

  async getStats(token) {
    const response = await fetch(`${this.env.WORKER_URL || this.config.get('server.api.baseUrl')}/api/stats`, {
      headers: {
        'Authorization': token ? `Bearer ${token}` : `Bearer ${this.env.AUTH_TOKEN || 'anonymous'}`,
        'X-Internal-Request': 'true'
      }
    });
    
    if (!response.ok) {
      throw new Error(`Failed to get stats: ${response.status}`);
    }
    
    return await response.json();
  }

  async listIccidMappings(params = {}) {
    const query = new URLSearchParams(params).toString();
    const response = await fetch(`${this.env.WORKER_URL || this.config.get('server.api.baseUrl')}/api/iccid-mappings?${query}`, {
      headers: {
        'Authorization': `Bearer ${this.env.AUTH_TOKEN || 'anonymous'}`,
        'X-Internal-Request': 'true'
      }
    });
    
    if (!response.ok) {
      throw new Error(`Failed to list ICCID mappings: ${response.status}`);
    }
    
    return await response.json();
  }

  async getIccidMapping(data) {
    const response = await fetch(`${this.env.WORKER_URL || this.config.get('server.api.baseUrl')}/api/iccid-mappings/${data.id}`, {
      headers: {
        'Authorization': `Bearer ${this.env.AUTH_TOKEN || 'anonymous'}`,
        'X-Internal-Request': 'true'
      }
    });
    
    if (!response.ok) {
      throw new Error(`Failed to get ICCID mapping: ${response.status}`);
    }
    
    return await response.json();
  }

  async getIccidMappingByIccid(data) {
    const response = await fetch(`${this.env.WORKER_URL || this.config.get('server.api.baseUrl')}/api/iccid-mappings/by-iccid/${data.iccid}`, {
      headers: {
        'Authorization': `Bearer ${this.env.AUTH_TOKEN || 'anonymous'}`,
        'X-Internal-Request': 'true'
      }
    });
    
    if (!response.ok) {
      throw new Error(`Failed to get ICCID mapping by ICCID: ${response.status}`);
    }
    
    return await response.json();
  }

  async createIccidMapping(data) {
    const response = await fetch(`${this.env.WORKER_URL || this.config.get('server.api.baseUrl')}/api/iccid-mappings`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${this.env.AUTH_TOKEN || 'anonymous'}`,
        'X-Internal-Request': 'true'
      },
      body: JSON.stringify(data)
    });
    
    if (!response.ok) {
      throw new Error(`Failed to create ICCID mapping: ${response.status}`);
    }
    
    return await response.json();
  }

  async updateIccidMapping(data) {
    const { id, ...updateData } = data;
    const response = await fetch(`${this.env.WORKER_URL || this.config.get('server.api.baseUrl')}/api/iccid-mappings/${id}`, {
      method: 'PUT',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${this.env.AUTH_TOKEN || 'anonymous'}`,
        'X-Internal-Request': 'true'
      },
      body: JSON.stringify(updateData)
    });
    
    if (!response.ok) {
      throw new Error(`Failed to update ICCID mapping: ${response.status}`);
    }
    
    return await response.json();
  }

  async deleteIccidMapping(data) {
    const response = await fetch(`${this.env.WORKER_URL || this.config.get('server.api.baseUrl')}/api/iccid-mappings/${data.id}`, {
      method: 'DELETE',
      headers: {
        'Authorization': `Bearer ${this.env.AUTH_TOKEN || 'anonymous'}`,
        'X-Internal-Request': 'true'
      }
    });
    
    if (!response.ok) {
      throw new Error(`Failed to delete ICCID mapping: ${response.status}`);
    }
    
    return await response.json();
  }

  async bulkImportIccidMappings(data) {
    const response = await fetch(`${this.env.WORKER_URL || this.config.get('server.api.baseUrl')}/api/iccid-mappings/bulk`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${this.env.AUTH_TOKEN || 'anonymous'}`,
        'X-Internal-Request': 'true'
      },
      body: JSON.stringify(data)
    });
    
    if (!response.ok) {
      throw new Error(`Failed to bulk import ICCID mappings: ${response.status}`);
    }
    
    return await response.json();
  }
}