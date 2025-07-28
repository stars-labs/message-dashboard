#!/usr/bin/env node

const API_URL = 'https://sexy.qzz.io';

// You'll need to get a valid auth token from the browser
// Open DevTools, go to Application > Local Storage and copy the auth_token value
const AUTH_TOKEN = process.env.AUTH_TOKEN || 'YOUR_AUTH_TOKEN_HERE';

function checkAuth() {
  if (!AUTH_TOKEN || AUTH_TOKEN === 'YOUR_AUTH_TOKEN_HERE') {
    console.error('Please set AUTH_TOKEN environment variable');
    console.error('Get it from browser DevTools: Application > Local Storage > auth_token');
    process.exit(1);
  }
}

async function listIccidMappings() {
  checkAuth();
  
  try {
    console.log('Listing ICCID mappings...');
    
    const response = await fetch(`${API_URL}/api/iccid-mappings`, {
      headers: {
        'Authorization': `Bearer ${AUTH_TOKEN}`,
        'Content-Type': 'application/json'
      }
    });

    console.log('Response status:', response.status);
    const result = await response.json();
    
    if (response.ok && result.success) {
      console.log('✅ Successfully retrieved mappings');
      console.log(`Total mappings: ${result.data.length}`);
      result.data.forEach(mapping => {
        console.log(`- ID: ${mapping.id}, ICCID: ${mapping.iccid}, Phone: ${mapping.phone_number}`);
      });
      return result.data;
    } else {
      console.error('❌ Failed to list mappings:', result);
      return [];
    }
  } catch (error) {
    console.error('Error:', error);
    return [];
  }
}

async function createIccidMapping(iccid, phoneNumber) {
  checkAuth();
  
  try {
    console.log(`\nCreating ICCID mapping: ${iccid} -> ${phoneNumber}`);
    
    const response = await fetch(`${API_URL}/api/iccid-mappings`, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${AUTH_TOKEN}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        iccid: iccid,
        phone_number: phoneNumber,
        carrier: 'Test Carrier',
        description: 'Test mapping created by script'
      })
    });

    console.log('Response status:', response.status);
    const result = await response.json();
    
    if (response.ok && result.success) {
      console.log('✅ Successfully created mapping');
      console.log('New mapping ID:', result.data.id);
      return result.data.id;
    } else {
      console.error('❌ Failed to create mapping:', result);
      return null;
    }
  } catch (error) {
    console.error('Error:', error);
    return null;
  }
}

async function deleteIccidMapping(id) {
  checkAuth();
  
  try {
    console.log(`\nDeleting ICCID mapping ID: ${id}`);
    
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
      return true;
    } else {
      console.error('❌ Failed to delete ICCID mapping:', result);
      return false;
    }
  } catch (error) {
    console.error('Error:', error);
    return false;
  }
}

async function runTests() {
  console.log('=== ICCID Mapping CRUD Tests ===\n');
  
  // Test 1: List mappings
  console.log('Test 1: List current mappings');
  const mappings = await listIccidMappings();
  
  // Test 2: Create a test mapping
  console.log('\nTest 2: Create a test mapping');
  const testIccid = `TEST_${Date.now()}`;
  const testPhone = '+1234567890';
  const newId = await createIccidMapping(testIccid, testPhone);
  
  if (newId) {
    // Test 3: Delete the test mapping
    console.log('\nTest 3: Delete the test mapping');
    await deleteIccidMapping(newId);
    
    // Test 4: Verify deletion
    console.log('\nTest 4: Verify deletion');
    await listIccidMappings();
  }
  
  console.log('\n=== Tests Complete ===');
}

// Handle command line arguments
const command = process.argv[2];
const arg1 = process.argv[3];
const arg2 = process.argv[4];

if (command === 'list') {
  listIccidMappings();
} else if (command === 'create' && arg1 && arg2) {
  createIccidMapping(arg1, arg2);
} else if (command === 'delete' && arg1) {
  deleteIccidMapping(arg1);
} else if (command === 'test') {
  runTests();
} else {
  console.log('Usage:');
  console.log('  node test-iccid-crud.js list                    - List all mappings');
  console.log('  node test-iccid-crud.js create <iccid> <phone>  - Create a mapping');
  console.log('  node test-iccid-crud.js delete <id>             - Delete a mapping');
  console.log('  node test-iccid-crud.js test                    - Run all tests');
  console.log('\nFirst, set AUTH_TOKEN environment variable from browser DevTools');
}