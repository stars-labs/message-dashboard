#!/usr/bin/env node

// This script uses the API key to trigger batch processing
// The API key auth bypasses user auth for control endpoints

async function batchProcessWithApiKey() {
  const API_KEY = process.env.API_KEY || '4025b019988238528f1fd5e909d0363c46e4e48490ea5045a9a490c259071cba';
  const API_URL = 'https://sexy.qzz.io/api/ai/batch-process';
  
  console.log('Starting batch processing with API key authentication...\n');
  
  try {
    // Note: The batch-process endpoint requires user auth, not API key
    // We need to modify the backend to accept API key for this endpoint
    const response = await fetch(API_URL + '?limit=100', {
      method: 'POST',
      headers: {
        'X-API-Key': API_KEY,
        'Content-Type': 'application/json'
      }
    });

    if (response.status === 401) {
      console.error('Authentication failed. The batch process endpoint requires user authentication.');
      console.log('\nTo process historical messages, you need to:');
      console.log('1. Log into the dashboard at https://sexy.qzz.io');
      console.log('2. Open browser developer tools (F12)');
      console.log('3. Go to Application > Cookies');
      console.log('4. Find and copy the "auth_token" cookie value');
      console.log('5. Run: AUTH_TOKEN="your-token" node scripts/test-batch-process.js');
      return;
    }

    const data = await response.json();
    
    if (!response.ok) {
      console.error('Failed:', response.status, data);
      return;
    }

    console.log('Success!', data);
    
    if (data.data) {
      console.log(`\nProcessed: ${data.data.processed} messages`);
      console.log(`Failed: ${data.data.failed}`);
      console.log(`Verification codes found: ${data.data.verification_codes_found}`);
      console.log(`Has more messages: ${data.has_more}`);
      
      if (data.has_more) {
        console.log('\nThere are more messages to process. Run the script again to continue.');
      }
    }

  } catch (error) {
    console.error('Error:', error.message);
  }
}

batchProcessWithApiKey();