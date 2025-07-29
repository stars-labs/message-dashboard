#!/usr/bin/env node

// Test API key directly to verify it works
const apiKey = process.env.TEST_API_KEY || process.argv[2];

if (!apiKey) {
  console.error('Usage: TEST_API_KEY=your-key node test-api-key-direct.js');
  console.error('   or: node test-api-key-direct.js your-key');
  process.exit(1);
}

console.log(`Testing API key: ${apiKey.substring(0, 8)}... (length: ${apiKey.length})`);

// Test heartbeat endpoint
async function testHeartbeat() {
  const url = 'https://sexy.qzz.io/api/control/heartbeat';
  console.log(`\nTesting ${url}`);
  
  try {
    const response = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-API-Key': apiKey
      },
      body: JSON.stringify({
        device_id: 'test-script',
        version: '1.0.0',
        status: 'online'
      })
    });
    
    console.log(`Status: ${response.status} ${response.statusText}`);
    console.log('Headers:', Object.fromEntries(response.headers.entries()));
    const body = await response.text();
    console.log('Response:', body);
    
    if (response.status === 200) {
      console.log('✅ API key is valid!');
    } else if (response.status === 401) {
      console.log('❌ API key is invalid (401 Unauthorized)');
    }
  } catch (error) {
    console.error('Error:', error);
  }
}

// Test pending SMS endpoint
async function testPendingSMS() {
  const url = 'https://sexy.qzz.io/api/control/pending-sms';
  console.log(`\nTesting ${url}`);
  
  try {
    const response = await fetch(url, {
      method: 'GET',
      headers: {
        'Content-Type': 'application/json',
        'X-API-Key': apiKey
      }
    });
    
    console.log(`Status: ${response.status} ${response.statusText}`);
    const body = await response.text();
    console.log('Response:', body);
  } catch (error) {
    console.error('Error:', error);
  }
}

// Test with different header variations
async function testHeaderVariations() {
  console.log('\n=== Testing header variations ===');
  
  const variations = [
    { name: 'X-API-Key', description: 'Standard (uppercase)' },
    { name: 'x-api-key', description: 'Lowercase' },
    { name: 'X-Api-Key', description: 'Mixed case' },
    { name: 'Authorization', description: 'Bearer token', value: `Bearer ${apiKey}` }
  ];
  
  for (const variant of variations) {
    console.log(`\nTesting with header: ${variant.name} (${variant.description})`);
    
    const headers = {
      'Content-Type': 'application/json'
    };
    
    if (variant.value) {
      headers[variant.name] = variant.value;
    } else {
      headers[variant.name] = apiKey;
    }
    
    try {
      const response = await fetch('https://sexy.qzz.io/api/control/heartbeat', {
        method: 'POST',
        headers,
        body: JSON.stringify({
          device_id: 'test-script',
          version: '1.0.0',
          status: 'online'
        })
      });
      
      console.log(`  Status: ${response.status} - ${response.status === 200 ? '✅' : '❌'}`);
    } catch (error) {
      console.error(`  Error: ${error.message}`);
    }
  }
}

// Check API key for common issues
function checkAPIKey() {
  console.log('\n=== API Key Analysis ===');
  console.log(`Length: ${apiKey.length} characters`);
  console.log(`First 16 chars: ${apiKey.substring(0, 16)}`);
  console.log(`Last 8 chars: ...${apiKey.substring(apiKey.length - 8)}`);
  
  // Check for whitespace
  if (apiKey !== apiKey.trim()) {
    console.log('⚠️  WARNING: API key has leading/trailing whitespace');
  }
  
  // Check for newlines
  if (apiKey.includes('\n') || apiKey.includes('\r')) {
    console.log('⚠️  WARNING: API key contains newline characters');
  }
  
  // Check character set
  const validChars = /^[a-zA-Z0-9]+$/;
  if (!validChars.test(apiKey)) {
    console.log('⚠️  WARNING: API key contains non-alphanumeric characters');
  }
  
  // Show hex dump of first 16 bytes
  console.log('\nFirst 16 bytes (hex):');
  for (let i = 0; i < Math.min(16, apiKey.length); i++) {
    const byte = apiKey.charCodeAt(i);
    console.log(`  [${i}] 0x${byte.toString(16).padStart(2, '0')} '${apiKey[i]}'`);
  }
}

// Run tests
async function main() {
  checkAPIKey();
  await testHeartbeat();
  await testPendingSMS();
  await testHeaderVariations();
}

main().catch(console.error);