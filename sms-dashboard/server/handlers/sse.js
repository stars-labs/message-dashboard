// Server-Sent Events handler with broadcasting support
const activeConnections = new Map(); // Map of connectionId -> { writer, encoder, user }

export const sseHandler = async (request) => {
  const { env, user } = request;
  
  // Validate user is authenticated
  if (!user) {
    return new Response(JSON.stringify({ error: 'Unauthorized' }), {
      status: 401,
      headers: { 'Content-Type': 'application/json' }
    });
  }
  
  // Create a readable stream for SSE
  const { readable, writable } = new TransformStream();
  const writer = writable.getWriter();
  const encoder = new TextEncoder();
  const connectionId = crypto.randomUUID();
  
  // Store this connection for broadcasting
  activeConnections.set(connectionId, { writer, encoder, user });
  
  // Send initial connection message
  const connectionMessage = {
    type: 'connected',
    user: user,
    timestamp: new Date().toISOString(),
    connectionId: connectionId
  };
  
  await writer.write(encoder.encode(`data: ${JSON.stringify(connectionMessage)}\n\n`));
  
  // Keep connection alive with periodic heartbeats
  const heartbeatInterval = setInterval(async () => {
    try {
      const heartbeat = {
        type: 'heartbeat',
        timestamp: new Date().toISOString()
      };
      await writer.write(encoder.encode(`data: ${JSON.stringify(heartbeat)}\n\n`));
    } catch (error) {
      // Connection closed, cleanup
      console.log(`[SSE] Heartbeat failed for connection ${connectionId}, cleaning up`);
      clearInterval(heartbeatInterval);
      activeConnections.delete(connectionId);
    }
  }, 30000); // Send heartbeat every 30 seconds
  
  // Handle connection close
  const cleanupConnection = () => {
    console.log(`[SSE] Connection ${connectionId} closed, cleaning up`);
    clearInterval(heartbeatInterval);
    activeConnections.delete(connectionId);
    try {
      writer.close();
    } catch (error) {
      // Writer already closed
    }
  };
  
  // Listen for connection abort
  if (request.signal) {
    request.signal.addEventListener('abort', cleanupConnection);
  }
  
  console.log(`[SSE] New connection established: ${connectionId} for user ${user.email || user.sub}`);
  console.log(`[SSE] Total active connections: ${activeConnections.size}`);
  
  return new Response(readable, {
    headers: {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      'Connection': 'keep-alive',
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Headers': 'Cache-Control',
      'X-Connection-Id': connectionId
    }
  });
};

// Broadcast a message to all SSE clients
export async function broadcastSSEEvent(type, data) {
  const message = {
    type,
    data,
    timestamp: new Date().toISOString()
  };
  
  const messageStr = `data: ${JSON.stringify(message)}\n\n`;
  console.log(`[SSE] Broadcasting ${type} event to ${activeConnections.size} connections`);
  
  // Send to all active connections
  const promises = [];
  for (const [connectionId, connection] of activeConnections) {
    const { writer, encoder } = connection;
    promises.push(
      writer.write(encoder.encode(messageStr)).catch((error) => {
        console.log(`[SSE] Failed to send to connection ${connectionId}, removing: ${error.message}`);
        activeConnections.delete(connectionId);
      })
    );
  }
  
  // Wait for all broadcasts to complete (or fail)
  await Promise.allSettled(promises);
  
  console.log(`[SSE] Broadcast completed, ${activeConnections.size} connections remain active`);
}

// Helper function to get connection count
export function getActiveConnectionCount() {
  return activeConnections.size;
}