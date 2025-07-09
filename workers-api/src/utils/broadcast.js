import { broadcastEvent as broadcastWebSocket } from './websocket';
import { broadcastSSEEvent } from '../handlers/sse';

/**
 * Broadcast an event to all connected clients via both WebSocket and SSE
 * @param {Object} env - Environment object
 * @param {string} type - Event type
 * @param {Object} data - Event data
 */
export async function broadcastToAll(env, type, data) {
  // Broadcast via WebSocket (Durable Objects)
  try {
    await broadcastWebSocket(env, type, data);
  } catch (error) {
    console.error('WebSocket broadcast error:', error);
  }
  
  // Broadcast via SSE
  try {
    broadcastSSEEvent(type, data);
  } catch (error) {
    console.error('SSE broadcast error:', error);
  }
}