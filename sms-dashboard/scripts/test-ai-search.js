#!/usr/bin/env node

// Test script for AI semantic search functionality
const API_URL = 'https://sexy.qzz.io';

async function testAISearch() {
  console.log('🔍 Testing AI Semantic Search Functionality\n');
  
  // Test queries
  const testQueries = [
    '所有的验证码',  // All verification codes (Chinese)
    'verification codes',  // English equivalent
    '抖音',  // TikTok messages  
    'douyin anti-fraud',  // TikTok anti-fraud in English
    '积分提醒',  // Points reminder
    'points notification',  // English equivalent
    '广东省爱卫办',  // Guangdong Health Office
    'mosquito prevention'  // English equivalent
  ];

  console.log('Step 1: Testing without authentication (should show public endpoint behavior)\n');

  for (const query of testQueries) {
    console.log(`🔎 Testing query: "${query}"`);
    
    try {
      const url = `${API_URL}/api/ai/search?q=${encodeURIComponent(query)}&limit=10`;
      console.log(`   URL: ${url}`);
      
      const response = await fetch(url, {
        method: 'GET',
        headers: {
          'Content-Type': 'application/json'
        }
      });

      const result = await response.json();
      
      if (response.ok && result.success) {
        console.log(`   ✅ Search successful`);
        console.log(`   📊 Results: ${result.data?.messages?.length || 0} messages found`);
        if (result.data?.messages?.length > 0) {
          console.log(`   📝 First result: "${result.data.messages[0].content.substring(0, 50)}..."`);
        }
        console.log(`   🧠 Search intent: ${JSON.stringify(result.data?.search_intent)}`);
      } else {
        console.log(`   ❌ Search failed: ${result.error || 'Unknown error'}`);
        console.log(`   🔧 Response status: ${response.status}`);
        if (response.status === 401) {
          console.log(`   🔐 Authentication required for AI search`);
        }
      }
    } catch (error) {
      console.log(`   ❌ Error: ${error.message}`);
    }
    
    console.log('');
  }
}

async function checkAIProcessingStatus() {
  console.log('\n📊 Checking AI Processing Status\n');
  
  try {
    // Check batch processing endpoint
    const url = `${API_URL}/api/ai/batch-process?limit=10&offset=0`;
    console.log(`Testing batch processing endpoint: ${url}`);
    
    const response = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json'
      }
    });

    const result = await response.json();
    
    if (response.status === 401) {
      console.log('❌ Batch processing requires authentication');
      console.log('💡 To fix AI search:');
      console.log('   1. Log into the dashboard with proper credentials');
      console.log('   2. Messages need to be processed with AI to generate embeddings');
      console.log('   3. Use the batch processing API endpoint to process existing messages');
    } else {
      console.log('✅ Batch processing endpoint accessible');
      console.log(`Result:`, result);
    }
  } catch (error) {
    console.log(`❌ Error checking batch processing: ${error.message}`);
  }
}

async function suggestFix() {
  console.log('\n🔧 AI Search Fix Recommendations\n');
  
  console.log('The AI search is not working because:');
  console.log('1. ❌ No messages have been processed with AI (embeddings missing)');
  console.log('2. ❌ Authentication required for AI endpoints');
  console.log('3. ❌ Vector search requires embeddings to be generated first');
  
  console.log('\n📋 Steps to fix:');
  console.log('1. ✅ Ensure user authentication works properly');
  console.log('2. ✅ Process existing messages with AI batch processing');
  console.log('3. ✅ Generate embeddings for vector search');
  console.log('4. ✅ Test search with properly processed messages');
  
  console.log('\n🚀 Quick fixes to implement:');
  console.log('- Add fallback search when no embeddings exist');
  console.log('- Show "processing required" message to users');
  console.log('- Auto-process messages when search is first used');
  console.log('- Improve error handling in SemanticSearch component');
}

async function main() {
  await testAISearch();
  await checkAIProcessingStatus(); 
  await suggestFix();
}

main().catch(console.error);