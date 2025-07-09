export class WebSocketRoom {
  constructor(state, env) {
    this.state = state;
    this.env = env;
    this.sessions = new Map();
  }

  async fetch(request) {
    const url = new URL(request.url);
    console.log('Durable Object received request for:', url.pathname, 'with query:', url.search);
    
    switch (url.pathname) {
      case '/websocket':
        return this.handleWebSocket(request);
      case '/broadcast':
        return this.handleBroadcast(request);
      default:
        console.error('Durable Object: Unknown path:', url.pathname);
        return new Response('Not found', { status: 404 });
    }
  }

  async handleWebSocket(request) {
    try {
      const upgradeHeader = request.headers.get('Upgrade');
      console.log('WebSocket upgrade header:', upgradeHeader);
      
      if (!upgradeHeader || upgradeHeader !== 'websocket') {
        return new Response('Expected Upgrade: websocket', { status: 426 });
      }

      const authToken = new URL(request.url).searchParams.get('token');
      console.log('WebSocket auth token:', authToken);
      
      if (!authToken) {
        return new Response('Unauthorized', { status: 401 });
      }

      const sessionData = await this.env.SESSIONS.get(authToken);
      console.log('Session data exists:', !!sessionData);
      
      if (!sessionData) {
        return new Response('Invalid session', { status: 401 });
      }

      const session = JSON.parse(sessionData);
      const user = session.user;
      
      const webSocketPair = new WebSocketPair();
      const [client, server] = Object.values(webSocketPair);

      const sessionId = crypto.randomUUID();
      
      this.state.acceptWebSocket(server);
      
      server.addEventListener('message', async (event) => {
        try {
          const message = JSON.parse(event.data);
          await this.handleMessage(sessionId, message, user);
        } catch (error) {
          server.send(JSON.stringify({
            type: 'error',
            message: 'Invalid message format'
          }));
        }
      });

      server.addEventListener('close', () => {
        this.sessions.delete(sessionId);
        this.broadcastUserStatus();
      });

      this.sessions.set(sessionId, {
        websocket: server,
        user: user,
        connectedAt: new Date().toISOString()
      });

      server.send(JSON.stringify({
        type: 'connected',
        sessionId: sessionId,
        user: user
      }));

      this.broadcastUserStatus();

      return new Response(null, {
        status: 101,
        webSocket: client,
      });
    } catch (error) {
      console.error('WebSocket handler error:', error);
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
          console.error('Error sending to client:', error);
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
        console.error('Error broadcasting user status:', error);
      }
    });
  }
}