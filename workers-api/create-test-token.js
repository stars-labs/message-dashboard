// Script to create a test token for WebSocket testing
import { nanoid } from 'nanoid';

const testToken = 'test-websocket-token-' + nanoid();
const testUser = {
  user: {
    id: 'test-user-123',
    email: 'test@example.com',
    name: 'Test User'
  },
  expires_at: Date.now() + (24 * 60 * 60 * 1000) // 24 hours
};

console.log('Test Token:', testToken);
console.log('User Data:', JSON.stringify(testUser));
console.log('\nTo create this token in KV, run:');
console.log(`wrangler kv:key put --binding=SESSIONS "${testToken}" '${JSON.stringify(testUser)}'`);