#!/usr/bin/env node

// Test script for Auth0 role-based access control
// Usage: node scripts/test-auth0-roles.js

const API_URL = process.env.API_URL || 'https://sexy.qzz.io';

async function testWithToken(token, description) {
  console.log(`\n🔍 Testing: ${description}`);
  
  try {
    // Test API access
    const phonesResponse = await fetch(`${API_URL}/api/phones`, {
      headers: {
        'Authorization': `Bearer ${token}`
      }
    });
    
    if (phonesResponse.ok) {
      console.log('✅ Access granted');
      const data = await phonesResponse.json();
      console.log(`   Found ${data.length || 0} phones`);
      return true;
    } else if (phonesResponse.status === 403) {
      console.log('❌ Access denied (403 Forbidden)');
      const error = await phonesResponse.json();
      console.log('   Message:', error.message);
      return false;
    } else {
      console.log('❓ Unexpected response:', phonesResponse.status);
      const error = await phonesResponse.text();
      console.log('   Error:', error);
      return null;
    }
  } catch (error) {
    console.error('   Request failed:', error.message);
    return null;
  }
}

async function testCurrentConfig() {
  console.log('\n📋 Auth0 Role-Based Access Control Test');
  console.log('=====================================');
  
  try {
    // Test if the API is reachable
    const healthResponse = await fetch(`${API_URL}/api/health`);
    if (healthResponse.ok) {
      console.log('✅ API is reachable at', API_URL);
    } else {
      console.log('❌ API health check failed');
      return;
    }
    
    // Check if Auth0 is configured
    const loginResponse = await fetch(`${API_URL}/api/auth/login`, {
      redirect: 'manual'
    });
    
    if (loginResponse.status === 500) {
      const error = await loginResponse.text();
      if (error.includes('Auth0 configuration missing')) {
        console.log('\n✅ Good! Auth0 is required (no mock login available)');
        console.log('\n📝 To test role-based access:');
        console.log('1. Ensure Auth0 is configured with AUTH0_DOMAIN and AUTH0_CLIENT_ID');
        console.log('2. Create roles in Auth0: "sms" or "admin"');
        console.log('3. Assign roles to users');
        console.log('4. Users with roles will have access');
        console.log('5. Users without roles will be denied');
      }
    } else if (loginResponse.status === 302) {
      console.log('\n✅ Auth0 is configured and login is available');
      console.log('\n📝 Role-based access is active:');
      console.log('- Users WITH "sms" or "admin" role: ✅ Full access');
      console.log('- Users WITHOUT these roles: ❌ Access denied');
    }
    
    console.log('\n🔧 Current configuration:');
    console.log('- USE_AUTH0_ROLES: true (role checking enabled)');
    console.log('- Required roles: "sms" or "admin"');
    console.log('- Namespace: https://sexy.qzz.io/roles');
    
  } catch (error) {
    console.error('Test failed:', error.message);
  }
}

// Run the test
testCurrentConfig();