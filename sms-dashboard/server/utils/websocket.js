export async function broadcastEvent(env, type, data) {
  try {
    console.log(`[websocket.js] Broadcasting event: ${type}`);
    console.log(`[websocket.js] WEBSOCKET_ROOMS available: ${!!env.WEBSOCKET_ROOMS}`);
    
    if (!env.WEBSOCKET_ROOMS) {
      console.error('[websocket.js] WEBSOCKET_ROOMS not available in env');
      return { error: 'WEBSOCKET_ROOMS not configured' };
    }
    
    const roomId = env.WEBSOCKET_ROOMS.idFromName('global');
    console.log(`[websocket.js] Room ID: ${roomId}`);
    
    const room = env.WEBSOCKET_ROOMS.get(roomId);
    console.log(`[websocket.js] Got room instance`);
    
    const response = await room.fetch(new Request('https://websocket/broadcast', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({ type, data })
    }));
    
    const result = await response.json();
    console.log(`[websocket.js] Broadcast response:`, result);
    
    return result;
  } catch (error) {
    console.error('Error broadcasting WebSocket event:', error);
    return { error: error.message };
  }
}