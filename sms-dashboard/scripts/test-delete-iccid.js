#!/usr/bin/env node

const API_URL = 'https://sexy.qzz.io';

// You'll need to get a valid auth token from the browser
// Open DevTools, go to Application > Local Storage and copy the auth_token value
const AUTH_TOKEN = process.env.AUTH_TOKEN || 'YOUR_AUTH_TOKEN_HERE';

async function testDeleteIccidMapping(id) {
  if (!AUTH_TOKEN || AUTH_TOKEN === 'YOUR_AUTH_TOKEN_HERE') {
    console.error('Please set AUTH_TOKEN environment variable');
    console.error('Get it from browser DevTools: Application > Local Storage > auth_token');
    process.exit(1);
  }

  try {
    console.log(`Testing delete for ICCID mapping ID: ${id}`);
    
    const response = await fetch(`${API_URL}/api/iccid-mappings/${id}`, {
      method: 'DELETE',
      headers: {
        'Authorization': `Bearer ${AUTH_TOKEN}`,
        'Content-Type': 'application/json'
      }
    });

    console.log('Response status:', response.status);
    const result = await response.json();
    console.log('Response:', JSON.stringify(result, null, 2));
    
    if (response.ok && result.success) {
      console.log('✅ Successfully deleted ICCID mapping');
    } else {
      console.error('❌ Failed to delete ICCID mapping:', result);
    }
  } catch (error) {
    console.error('Error:', error);
  }
}

// Get ID from command line argument
const id = process.argv[2];
if (!id) {
  console.error('Usage: node test-delete-iccid.js <mapping-id>');
  console.error('Get the ID from the ICCID mappings page');
  process.exit(1);
}

testDeleteIccidMapping(id);