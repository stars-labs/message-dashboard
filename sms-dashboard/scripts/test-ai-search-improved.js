#!/usr/bin/env node

/**
 * Test script for AI Search functionality with improved fallback
 */

import fetch from 'node-fetch';
import { config } from 'dotenv';

config();

const API_URL = process.env.API_URL || 'https://sexy.qzz.io';
const AUTH_TOKEN = process.env.AUTH_TOKEN;

const colors = {
  reset: '\x1b[0m',
  bright: '\x1b[1m',
  green: '\x1b[32m',
  red: '\x1b[31m',
  yellow: '\x1b[33m',
  cyan: '\x1b[36m',
  magenta: '\x1b[35m'
};

function log(message, color = colors.reset) {
  console.log(`${color}${message}${colors.reset}`);
}

async function testSearch(query, expectedResults = true) {
  log(`\n📝 Testing search: "${query}"`, colors.cyan);
  
  try {
    const url = `${API_URL}/api/ai/search?q=${encodeURIComponent(query)}&limit=10`;
    log(`   URL: ${url}`, colors.reset);
    
    const response = await fetch(url, {
      headers: {
        'Authorization': `Bearer ${AUTH_TOKEN}`,
        'Content-Type': 'application/json'
      }
    });
    
    const data = await response.json();
    
    if (!response.ok) {
      throw new Error(`HTTP ${response.status}: ${data.error || 'Unknown error'}`);
    }
    
    if (data.success) {
      const messages = data.data?.messages || [];
      const method = data.data?.search_method || 'unknown';
      
      log(`   ✅ Search successful (${method} search)`, colors.green);
      log(`   📊 Found ${messages.length} messages`, colors.green);
      
      if (data.data?.note) {
        log(`   ℹ️  Note: ${data.data.note}`, colors.yellow);
      }
      
      if (messages.length > 0) {
        log(`   📱 Sample results:`, colors.magenta);
        messages.slice(0, 3).forEach((msg, i) => {
          const preview = msg.content.substring(0, 100).replace(/\n/g, ' ');
          log(`      ${i + 1}. ${preview}${msg.content.length > 100 ? '...' : ''}`, colors.reset);
          if (msg.ai_verification_code) {
            log(`         🔑 Code: ${msg.ai_verification_code}`, colors.cyan);
          }
        });
      } else if (expectedResults) {
        log(`   ⚠️  No results found (expected some)`, colors.yellow);
      }
      
      return { success: true, count: messages.length, method };
    } else {
      throw new Error(data.error || 'Search failed');
    }
  } catch (error) {
    log(`   ❌ Error: ${error.message}`, colors.red);
    return { success: false, error: error.message };
  }
}

async function runTests() {
  log('\n🚀 Starting AI Search Tests', colors.bright + colors.cyan);
  log('=' .repeat(50), colors.cyan);
  
  if (!AUTH_TOKEN) {
    log('\n⚠️  No AUTH_TOKEN provided. Tests may fail if authentication is required.', colors.yellow);
    log('   Set AUTH_TOKEN environment variable to test with authentication.', colors.yellow);
  }
  
  // Test cases
  const testCases = [
    { query: '所有的验证码', expected: true, description: 'Chinese: all verification codes' },
    { query: 'verification codes', expected: true, description: 'English: verification codes' },
    { query: 'OTP', expected: true, description: 'Search for OTP' },
    { query: 'code', expected: true, description: 'Simple code search' },
    { query: '验证码', expected: true, description: 'Chinese: verification code' },
    { query: 'all messages', expected: true, description: 'Get all messages' },
    { query: '所有', expected: true, description: 'Chinese: all' },
    { query: 'random_string_xyz123', expected: false, description: 'Non-existent content' }
  ];
  
  const results = [];
  
  for (const testCase of testCases) {
    log(`\n${testCase.description}`, colors.bright);
    const result = await testSearch(testCase.query, testCase.expected);
    results.push({
      ...testCase,
      ...result
    });
    
    // Small delay between tests
    await new Promise(resolve => setTimeout(resolve, 500));
  }
  
  // Summary
  log('\n' + '=' .repeat(50), colors.cyan);
  log('📊 Test Summary', colors.bright + colors.cyan);
  log('=' .repeat(50), colors.cyan);
  
  const successful = results.filter(r => r.success).length;
  const failed = results.filter(r => !r.success).length;
  const aiSearches = results.filter(r => r.method === 'ai').length;
  const textSearches = results.filter(r => r.method === 'text').length;
  const fallbackSearches = results.filter(r => r.method === 'fallback').length;
  
  log(`\n✅ Successful: ${successful}/${results.length}`, colors.green);
  if (failed > 0) {
    log(`❌ Failed: ${failed}/${results.length}`, colors.red);
  }
  
  log(`\n🤖 Search Methods Used:`, colors.magenta);
  log(`   - AI-powered: ${aiSearches}`, colors.cyan);
  log(`   - Text-based: ${textSearches}`, colors.cyan);
  log(`   - Fallback: ${fallbackSearches}`, colors.cyan);
  
  log('\n' + '=' .repeat(50), colors.cyan);
  
  // Exit with appropriate code
  process.exit(failed > 0 ? 1 : 0);
}

// Run the tests
runTests().catch(error => {
  log(`\n💥 Fatal error: ${error.message}`, colors.red);
  process.exit(1);
});