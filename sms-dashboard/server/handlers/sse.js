// Server-Sent Events handler for real-time updates
export async function sseHandler(request) {
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
  
  // Send initial connection message
  writer.write(encoder.encode(`data: ${JSON.stringify({
    type: 'connected',
    user: user,
    timestamp: new Date().toISOString()
  })}\n\n`));
  
  // Keep connection alive with periodic heartbeats
  const heartbeatInterval = setInterval(() => {
    writer.write(encoder.encode(`data: ${JSON.stringify({
      type: 'heartbeat',
      timestamp: new Date().toISOString()
    })}\n\n`)).catch(() => {
      // Connection closed, cleanup
      clearInterval(heartbeatInterval);
    });
  }, 30000); // Send heartbeat every 30 seconds
  
  // Store connection ID for potential broadcasting
  const connectionId = crypto.randomUUID();
  
  // Note: In a real implementation, you'd want to store this connection
  // in a shared state (like Durable Objects or external service)
  // for broadcasting messages to all connected clients
  
  // Handle connection close
  request.signal.addEventListener('abort', () => {
    clearInterval(heartbeatInterval);
    writer.close();
  });
  
  return new Response(readable, {
    headers: {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      'Connection': 'keep-alive',
      'X-Connection-Id': connectionId
    }
  });
}

// Broadcast a message to all SSE clients
export async function broadcastSSEEvent(env, type, data) {
  // In a real implementation, this would send to all connected SSE clients
  // For now, this is a placeholder that shows the structure
  const message = {
    type,
    data,
    timestamp: new Date().toISOString()
  };
  
  // You could store SSE connections in Durable Objects or use
  // Cloudflare Pub/Sub when it becomes available
  console.log('SSE broadcast:', message);
}