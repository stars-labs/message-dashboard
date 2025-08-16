#!/usr/bin/env node

/**
 * Test script to verify Vectorize metadata filtering works
 * Run with: node scripts/test-vectorize.js
 */

const API_URL = 'https://sexy.qzz.io';

// Get auth token from environment or command line
const AUTH_TOKEN = process.env.AUTH_TOKEN || process.argv[2];

if (!AUTH_TOKEN) {
  console.error('❌ Please provide an auth token:');
  console.error('   AUTH_TOKEN=your_token node scripts/test-vectorize.js');
  console.error('   or');
  console.error('   node scripts/test-vectorize.js your_token');
  process.exit(1);
}

async function testSearch(query, params = {}) {
  const queryParams = new URLSearchParams({ q: query, ...params });
  const url = `${API_URL}/api/ai/search?${queryParams}`;
  
  console.log(`\n🔍 Testing search: "${query}"`);
  if (Object.keys(params).length > 0) {
    console.log(`   Parameters:`, params);
  }
  
  try {
    const response = await fetch(url, {
      headers: {
        'Authorization': `Bearer ${AUTH_TOKEN}`,
        'Content-Type': 'application/json'
      }
    });
    
    if (!response.ok) {
      throw new Error(`HTTP ${response.status}: ${response.statusText}`);
    }
    
    const data = await response.json();
    
    if (data.success) {
      console.log(`✅ Search successful!`);
      console.log(`   Method: ${data.data.search_method}`);
      console.log(`   Results: ${data.data.messages?.length || 0} messages`);
      
      if (data.data.messages?.length > 0) {
        console.log(`   Sample message: "${data.data.messages[0].content.substring(0, 50)}..."`);
      }
      
      if (data.data.search_intent) {
        console.log(`   Intent:`, data.data.search_intent);
      }
    } else {
      console.log(`❌ Search failed:`, data.error);
    }
    
    return data;
  } catch (error) {
    console.error(`❌ Error:`, error.message);
    return null;
  }
}

async function testChatbotSearch() {
  console.log(`\n🤖 Testing chatbot search with vector embeddings...`);
  
  const url = `${API_URL}/api/ai/chat`;
  
  try {
    const response = await fetch(url, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${AUTH_TOKEN}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        message: "Find all verification codes from the last week"
      })
    });
    
    if (!response.ok) {
      throw new Error(`HTTP ${response.status}: ${response.statusText}`);
    }
    
    const data = await response.json();
    
    if (data.success) {
      console.log(`✅ Chatbot response received!`);
      console.log(`   Response length: ${data.data.response?.length || 0} characters`);
      
      // Check if function calls were made
      if (data.data.function_calls?.length > 0) {
        console.log(`   Functions called:`, data.data.function_calls.map(f => f.name).join(', '));
        
        // Look for searchMessages call
        const searchCall = data.data.function_calls.find(f => f.name === 'searchMessages');
        if (searchCall?.result?.search_method) {
          console.log(`   Search method used: ${searchCall.result.search_method}`);
        }
      }
    } else {
      console.log(`❌ Chatbot failed:`, data.error);
    }
    
    return data;
  } catch (error) {
    console.error(`❌ Error:`, error.message);
    return null;
  }
}

async function getPhoneList() {
  const url = `${API_URL}/api/phones`;
  
  try {
    const response = await fetch(url, {
      headers: {
        'Authorization': `Bearer ${AUTH_TOKEN}`,
        'Content-Type': 'application/json'
      }
    });
    
    if (!response.ok) {
      throw new Error(`HTTP ${response.status}: ${response.statusText}`);
    }
    
    const data = await response.json();
    return data.data?.phones || [];
  } catch (error) {
    console.error(`❌ Error getting phones:`, error.message);
    return [];
  }
}

async function runTests() {
  console.log('🚀 Starting Vectorize metadata filtering tests...');
  console.log(`   API URL: ${API_URL}`);
  
  // Get a phone ID for testing
  console.log('\n📱 Getting phone list...');
  const phones = await getPhoneList();
  const testPhoneId = phones[0]?.id;
  
  if (testPhoneId) {
    console.log(`   Found ${phones.length} phones`);
    console.log(`   Using phone ID: ${testPhoneId.substring(0, 20)}...`);
  } else {
    console.log(`   No phones found, tests will run without phone_id filter`);
  }
  
  // Test 1: Basic semantic search (should use vector search)
  await testSearch('verification codes');
  
  // Test 2: Search with phone_id filter (tests metadata filtering)
  if (testPhoneId) {
    await testSearch('messages', { phone_id: testPhoneId });
  }
  
  // Test 3: Search with type filter
  await testSearch('recent messages', { type: 'received' });
  
  // Test 4: Search with multiple filters
  if (testPhoneId) {
    await testSearch('all messages', { 
      phone_id: testPhoneId, 
      type: 'received',
      limit: 10 
    });
  }
  
  // Test 5: Chinese language search
  await testSearch('验证码');
  
  // Test 6: Chatbot search (should use vector search internally)
  await testChatbotSearch();
  
  console.log('\n✨ Tests complete!');
}

// Run the tests
runTests().catch(console.error);