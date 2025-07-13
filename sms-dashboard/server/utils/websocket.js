export async function broadcastEvent(env, type, data) {
  // TODO: Fix WebSocket broadcast - temporarily disabled to prevent Worker hangs
  console.log(`WebSocket broadcast disabled: ${type}`);
  return { success: false, error: 'Broadcast temporarily disabled' };
  
  // Original implementation causing issues:
  // try {
  //   const roomId = env.WEBSOCKET_ROOMS.idFromName('global');
  //   const room = env.WEBSOCKET_ROOMS.get(roomId);
  //   
  //   const response = await room.fetch(new Request('https://websocket/broadcast', {
  //     method: 'POST',
  //     headers: {
  //       'Content-Type': 'application/json'
  //     },
  //     body: JSON.stringify({ type, data })
  //   }));
  //   
  //   return await response.json();
  // } catch (error) {
  //   console.error('Error broadcasting WebSocket event:', error);
  //   return { error: error.message };
  // }
}