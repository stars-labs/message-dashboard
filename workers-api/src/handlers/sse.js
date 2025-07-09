import { verifySession } from '../utils/verification';

class SSEConnection {
  constructor(writer, user) {
    this.writer = writer;
    this.user = user;
    this.id = crypto.randomUUID();
    this.closed = false;
  }

  send(event, data) {
    if (this.closed) return;
    
    try {
      const message = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
      this.writer.write(new TextEncoder().encode(message));
    } catch (error) {
      console.error('Error sending SSE message:', error);
      this.closed = true;
    }
  }

  close() {
    this.closed = true;
    try {
      this.writer.close();
    } catch (error) {
      console.error('Error closing SSE connection:', error);
    }
  }
}

// Store active SSE connections
const connections = new Map();

export async function handleSSE(request, env) {
  // Verify authentication
  const authToken = new URL(request.url).searchParams.get('token');
  if (!authToken) {
    return new Response('Unauthorized', { status: 401 });
  }

  const sessionData = await env.SESSIONS.get(authToken);
  if (!sessionData) {
    return new Response('Invalid session', { status: 401 });
  }

  const session = JSON.parse(sessionData);
  const user = session.user;

  // Create a TransformStream for SSE
  const { readable, writable } = new TransformStream();
  const writer = writable.getWriter();

  // Create SSE connection
  const connection = new SSEConnection(writer, user);
  connections.set(connection.id, connection);

  // Send initial connection event
  connection.send('connected', {
    connectionId: connection.id,
    user: user,
    timestamp: new Date().toISOString()
  });

  // Send active users
  const activeUsers = Array.from(connections.values()).map(conn => ({
    email: conn.user.email,
    connectionId: conn.id
  }));
  connection.send('activeUsers', activeUsers);

  // Broadcast to other connections
  broadcastToAll('userConnected', {
    email: user.email,
    connectionId: connection.id
  }, connection.id);

  // Set up heartbeat
  const heartbeatInterval = setInterval(() => {
    if (connection.closed) {
      clearInterval(heartbeatInterval);
      return;
    }
    connection.send('heartbeat', { timestamp: new Date().toISOString() });
  }, 30000); // 30 seconds

  // Clean up on disconnect
  request.signal.addEventListener('abort', () => {
    clearInterval(heartbeatInterval);
    connections.delete(connection.id);
    connection.close();
    
    // Broadcast disconnect
    broadcastToAll('userDisconnected', {
      email: user.email,
      connectionId: connection.id
    });
  });

  // Return SSE response
  return new Response(readable, {
    headers: {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      'Connection': 'keep-alive',
      'Access-Control-Allow-Origin': '*',
      'X-Accel-Buffering': 'no' // Disable Nginx buffering
    }
  });
}

function broadcastToAll(event, data, excludeId = null) {
  connections.forEach((connection, id) => {
    if (id !== excludeId && !connection.closed) {
      connection.send(event, data);
    }
  });
}

// Export a function to broadcast events from other parts of the application
export function broadcastSSEEvent(type, data) {
  broadcastToAll(type, {
    ...data,
    timestamp: new Date().toISOString()
  });
}

export const sseHandler = {
  connect: handleSSE
};