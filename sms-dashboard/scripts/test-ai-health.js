#!/usr/bin/env node

// Test if AI features are deployed by checking health endpoint
async function testAIHealth() {
  try {
    console.log('Testing AI endpoints health...\n');
    
    // Test the general health endpoint
    console.log('1. Testing general health endpoint:');
    const healthResponse = await fetch('https://sexy.qzz.io/api/health');
    console.log(`   Status: ${healthResponse.status} ${healthResponse.statusText}`);
    console.log(`   Response: ${await healthResponse.text()}\n`);
    
    // Test if routes are accessible (will get auth error but confirms route exists)
    const endpoints = [
      '/api/ai/extract-code',
      '/api/ai/search',
      '/api/ai/chat',
      '/api/ai/batch-process',
      '/api/ai/verification-codes'
    ];
    
    console.log('2. Testing AI endpoints (expecting 401 auth errors):');
    for (const endpoint of endpoints) {
      const response = await fetch(`https://sexy.qzz.io${endpoint}`);
      console.log(`   ${endpoint}: ${response.status} ${response.statusText}`);
    }
    
    console.log('\nIf you see 401 errors above, it means the AI endpoints are deployed and working!');
    console.log('The 401 errors are expected since we\'re not providing authentication.');
    
  } catch (error) {
    console.error('Error:', error);
  }
}

testAIHealth();