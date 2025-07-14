export async function broadcastEvent(env, type, data) {
  try {
    const roomId = env.WEBSOCKET_ROOMS.idFromName('global');
    const room = env.WEBSOCKET_ROOMS.get(roomId);
    
    const response = await room.fetch(new Request('https://websocket/broadcast', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({ type, data })
    }));
    
    return await response.json();
  } catch (error) {
    console.error('Error broadcasting WebSocket event:', error);
    return { error: error.message };
  }
}