export class WebSocketRoom {
  constructor(state, env) {
    this.state = state;
    this.env = env;
    this.sessions = new Map();
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
      
      // Handle incoming messages
      server.addEventListener('message', async (event) => {
        try {
          const message = JSON.parse(event.data);
          await this.handleMessage(sessionId, message, null);
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
    } catch (error) {
      return new Response('Internal Server Error: ' + error.message, { status: 500 });
    }
  }

  async handleBroadcast(request) {
    try {
      const { type, data } = await request.json();
      
      const message = JSON.stringify({
        type: type,
        data: data,
        timestamp: new Date().toISOString()
      });

      this.sessions.forEach((session) => {
        try {
          session.websocket.send(message);
        } catch (error) {
        }
      });

      return new Response(JSON.stringify({ success: true, recipients: this.sessions.size }), {
        headers: { 'Content-Type': 'application/json' }
      });
    } catch (error) {
      return new Response(JSON.stringify({ error: error.message }), {
        status: 400,
        headers: { 'Content-Type': 'application/json' }
      });
    }
  }

  async handleMessage(sessionId, message, user) {
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
      
      default:
        session.websocket.send(JSON.stringify({
          type: 'error',
          message: 'Unknown message type'
        }));
    }
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
}