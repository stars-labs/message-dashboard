#!/usr/bin/env node

// Test script for keyword functionality
// This script tests the keyword API endpoints without authentication

const API_BASE = 'https://sexy.qzz.io/api';

async function testKeywordEndpoints() {
  console.log('Testing keyword API endpoints...\n');

  // Test 1: Get all keywords (should work without auth)
  try {
    console.log('1. Testing GET /api/keywords...');
    const response = await fetch(`${API_BASE}/keywords`);
    console.log(`   Status: ${response.status}`);
    
    if (response.ok) {
      const data = await response.json();
      console.log(`   Success! Found ${data.keywords?.length || 0} keywords`);
      if (data.keywords?.length > 0) {
        console.log('   Sample keyword:', JSON.stringify(data.keywords[0], null, 2));
      }
    } else {
      console.log(`   Error: ${response.statusText}`);
    }
  } catch (error) {
    console.log(`   Error: ${error.message}`);
  }

  console.log('\n2. Testing keyword highlighting logic...');
  
  // Sample test data
  const testKeywords = [
    { keyword: 'verification', tag: 'auth', color: '#3B82F6', priority: 10, case_sensitive: false, whole_word: false, is_active: true },
    { keyword: 'code', tag: 'otp', color: '#10B981', priority: 5, case_sensitive: false, whole_word: true, is_active: true },
    { keyword: 'OTP', tag: 'otp', color: '#F59E0B', priority: 8, case_sensitive: true, whole_word: false, is_active: true }
  ];

  const testMessages = [
    'Your verification code is 123456',
    'Enter this code: 789012',
    'Your OTP is 345678',
    'This is a test message without keywords',
    'Verification CODE for OTP'
  ];

  console.log('   Test keywords:', testKeywords.map(k => k.keyword).join(', '));
  console.log('\n   Testing messages:');
  
  testMessages.forEach(message => {
    console.log(`\n   Message: "${message}"`);
    const matches = findKeywordMatches(message, testKeywords);
    if (matches.length > 0) {
      console.log(`   Matches found: ${matches.length}`);
      matches.forEach(match => {
        console.log(`     - "${match.text}" → tag: ${match.tag}, color: ${match.color}`);
      });
    } else {
      console.log('   No matches found');
    }
  });
}

// Simulated keyword matching logic (similar to frontend)
function findKeywordMatches(message, keywords) {
  const matches = [];
  const activeKeywords = keywords.filter(k => k.is_active).sort((a, b) => b.priority - a.priority);
  
  for (const keyword of activeKeywords) {
    const pattern = keyword.whole_word 
      ? `\\b${escapeRegex(keyword.keyword)}\\b`
      : escapeRegex(keyword.keyword);
    
    const flags = keyword.case_sensitive ? 'g' : 'gi';
    const regex = new RegExp(pattern, flags);
    
    let match;
    while ((match = regex.exec(message)) !== null) {
      matches.push({
        start: match.index,
        end: match.index + match[0].length,
        text: match[0],
        keyword: keyword.keyword,
        tag: keyword.tag,
        color: keyword.color,
        priority: keyword.priority
      });
    }
  }
  
  // Remove overlapping matches, keeping higher priority ones
  return matches.sort((a, b) => {
    if (a.start === b.start) return b.priority - a.priority;
    return a.start - b.start;
  }).filter((match, index, array) => {
    if (index === 0) return true;
    return match.start >= array[index - 1].end;
  });
}

function escapeRegex(string) {
  return string.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

// Run the test
testKeywordEndpoints();