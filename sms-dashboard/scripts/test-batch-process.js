#!/usr/bin/env node

async function testBatchProcess() {
  const API_URL = 'https://sexy.qzz.io/api/ai/batch-process?limit=10';
  
  // Get auth token from environment
  const authToken = process.env.AUTH_TOKEN;
  
  if (!authToken) {
    console.error('Please set AUTH_TOKEN environment variable');
    console.log('Example: AUTH_TOKEN="your-token" node scripts/test-batch-process.js');
    process.exit(1);
  }

  try {
    console.log('Testing batch process endpoint...');
    
    const response = await fetch(API_URL, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${authToken}`,
        'Content-Type': 'application/json'
      }
    });

    const data = await response.json();
    
    if (!response.ok) {
      console.error('Failed:', response.status, data);
      return;
    }

    console.log('Success!', data);
    
    if (data.data) {
      console.log(`Processed: ${data.data.processed}`);
      console.log(`Failed: ${data.data.failed}`);
      console.log(`Verification codes found: ${data.data.verification_codes_found}`);
      console.log(`Has more: ${data.has_more}`);
      
      if (data.data.messages && data.data.messages.length > 0) {
        console.log('\nProcessed messages:');
        data.data.messages.forEach(msg => {
          console.log(`- ${msg.id}: ${msg.classification}${msg.verification_code ? ` (Code: ${msg.verification_code})` : ''}`);
        });
      }
    }

  } catch (error) {
    console.error('Error:', error);
  }
}

testBatchProcess();