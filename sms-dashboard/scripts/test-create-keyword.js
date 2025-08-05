import fetch from 'node-fetch';

const API_BASE_URL = 'https://sexy.qzz.io';

async function testCreateKeyword() {
  try {
    // First, get a valid auth token
    console.log('=== Testing Keyword Creation ===');
    console.log('Note: Set AUTH_TOKEN environment variable with a valid Bearer token');
    console.log('You can get this from browser dev tools while logged in\n');
    
    const token = process.env.AUTH_TOKEN;
    if (!token) {
      console.error('ERROR: AUTH_TOKEN environment variable not set');
      console.log('Please run: export AUTH_TOKEN="your-bearer-token"');
      return;
    }
    
    // Test auth first
    console.log('1. Testing authentication...');
    const authResponse = await fetch(`${API_BASE_URL}/api/auth/me`, {
      headers: {
        'Authorization': `Bearer ${token}`
      }
    });
    
    if (!authResponse.ok) {
      console.error('Authentication failed:', authResponse.status);
      const errorText = await authResponse.text();
      console.error('Error:', errorText);
      return;
    }
    
    const authData = await authResponse.json();
    console.log('✓ Authenticated as:', authData.name);
    console.log('  Permissions:', authData.permissions);
    
    // List existing keywords
    console.log('\n2. Listing existing keywords...');
    const listResponse = await fetch(`${API_BASE_URL}/api/keywords`, {
      headers: {
        'Authorization': `Bearer ${token}`
      }
    });
    
    if (!listResponse.ok) {
      console.error('Failed to list keywords:', listResponse.status);
      const errorText = await listResponse.text();
      console.error('Error:', errorText);
    } else {
      const listData = await listResponse.json();
      console.log('✓ Existing keywords:', listData.keywords.map(k => k.keyword));
    }
    
    // Try to create a new keyword
    console.log('\n3. Creating new keyword...');
    const newKeyword = {
      keyword: 'test-' + Date.now(), // Unique keyword to avoid duplicates
      tag: 'Test Tag',
      color: '#FF6B6B',
      priority: 10,
      case_sensitive: false,
      whole_word: true
    };
    
    console.log('  Keyword data:', JSON.stringify(newKeyword, null, 2));
    
    const createResponse = await fetch(`${API_BASE_URL}/api/keywords`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${token}`
      },
      body: JSON.stringify(newKeyword)
    });
    
    console.log('  Response status:', createResponse.status);
    const responseText = await createResponse.text();
    
    let responseData;
    try {
      responseData = JSON.parse(responseText);
    } catch (e) {
      console.error('  Failed to parse response as JSON:', responseText);
      return;
    }
    
    if (!createResponse.ok) {
      console.error('✗ Failed to create keyword');
      console.error('  Error:', responseData.error || responseText);
      
      // Try with a simpler keyword
      console.log('\n4. Trying with simpler keyword...');
      const simpleKeyword = {
        keyword: 'simple' + Math.floor(Math.random() * 10000),
        tag: 'Simple',
        color: '#3B82F6'
      };
      
      const simpleResponse = await fetch(`${API_BASE_URL}/api/keywords`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${token}`
        },
        body: JSON.stringify(simpleKeyword)
      });
      
      const simpleResult = await simpleResponse.json();
      if (simpleResponse.ok) {
        console.log('✓ Simple keyword created successfully:', simpleResult.keyword);
      } else {
        console.error('✗ Simple keyword also failed:', simpleResult.error);
      }
    } else {
      console.log('✓ Keyword created successfully!');
      console.log('  Created keyword:', responseData.keyword);
      
      // Try to delete it to clean up
      if (responseData.keyword && responseData.keyword.id) {
        console.log('\n5. Cleaning up - deleting test keyword...');
        const deleteResponse = await fetch(`${API_BASE_URL}/api/keywords/${responseData.keyword.id}`, {
          method: 'DELETE',
          headers: {
            'Authorization': `Bearer ${token}`
          }
        });
        
        if (deleteResponse.ok) {
          console.log('✓ Test keyword deleted successfully');
        } else {
          console.log('✗ Failed to delete test keyword');
        }
      }
    }
    
  } catch (error) {
    console.error('\nUnexpected error:', error);
  }
}

// Run the test
testCreateKeyword();