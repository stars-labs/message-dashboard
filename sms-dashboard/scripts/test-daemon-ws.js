#!/usr/bin/env node

import WebSocket from 'ws';
import crypto from 'crypto';

const API_URL = 'https://sexy.qzz.io';
const API_KEY = '4025b019988238528f1fd5e909d0363c46e4e48490ea5045a9a490c259071cba';

console.log('Testing daemon WebSocket connection...');
console.log(`URL: ${API_URL}/api/daemon-ws`);
console.log(`API Key (first 8 chars): ${API_KEY.substring(0, 8)}...`);

// Try with query parameter since Authorization header might not work
const ws = new WebSocket(`${API_URL.replace('https://', 'wss://')}/api/daemon-ws?token=${API_KEY}`);

ws.on('open', () => {
  console.log('✅ WebSocket connected successfully!');
  
  // Send a heartbeat
  setTimeout(() => {
    const heartbeat = {
      type: 'heartbeat',
      id: crypto.randomUUID(),
      timestamp: new Date().toISOString(),
      data: {
        uptime: 100,
        device_id: 'test-daemon'
      }
    };
    console.log('Sending heartbeat:', heartbeat);
    ws.send(JSON.stringify(heartbeat));
  }, 1000);

  // Send a phone update
  setTimeout(() => {
    const phoneUpdate = {
      type: 'phone_update',
      id: crypto.randomUUID(),
      timestamp: new Date().toISOString(),
      data: {
        phones: [
          {
            iccid: '89860040191833946266',
            number: '+1234567890',
            status: 'online',
            signal: 75,
            carrier: 'Test Carrier',
            operator_name: 'Test Operator'
          }
        ]
      }
    };
    console.log('Sending phone update:', JSON.stringify(phoneUpdate, null, 2));
    ws.send(JSON.stringify(phoneUpdate));
  }, 2000);
});

ws.on('message', (data) => {
  console.log('Received message:', data.toString());
});

ws.on('error', (error) => {
  console.error('❌ WebSocket error:', error.message);
  if (error.message.includes('401')) {
    console.error('Authentication failed - check API key');
  }
});

ws.on('close', (code, reason) => {
  console.log(`WebSocket closed: ${code} - ${reason}`);
});

// Keep the script running for 30 seconds
setTimeout(() => {
  console.log('Closing connection...');
  ws.close();
  process.exit(0);
}, 30000);