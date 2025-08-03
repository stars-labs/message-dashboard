#!/usr/bin/env node

// Script to debug message count discrepancy
const ICCID = '89860118803426385081';

async function testMessageCount() {
  console.log(`\n=== Testing message count for ICCID: ${ICCID} ===\n`);
  
  // Test direct API call
  console.log('1. Testing direct API call to /api/messages with phone_iccid parameter:');
  try {
    const response = await fetch(`http://localhost:8787/api/messages?phone_iccid=${ICCID}&limit=100`, {
      headers: {
        'Authorization': 'Bearer anonymous'
      }
    });
    
    const data = await response.json();
    console.log(`   - Response status: ${response.status}`);
    console.log(`   - Success: ${data.success}`);
    console.log(`   - Message count: ${data.data ? data.data.length : 0}`);
    console.log(`   - Total count: ${data.pagination ? data.pagination.total : 'N/A'}`);
    
    if (data.data && data.data.length > 0) {
      console.log(`   - First message ICCID: ${data.data[0].phone_iccid}`);
      console.log(`   - Sample message: ${data.data[0].content?.substring(0, 50)}...`);
    }
  } catch (error) {
    console.error('   - Error:', error.message);
  }
  
  console.log('\n2. Testing API call without phone_iccid (all messages):');
  try {
    const response = await fetch('http://localhost:8787/api/messages?limit=2000', {
      headers: {
        'Authorization': 'Bearer anonymous'
      }
    });
    
    const data = await response.json();
    console.log(`   - Total messages loaded: ${data.data ? data.data.length : 0}`);
    
    if (data.data) {
      const messagesForPhone = data.data.filter(m => m.phone_iccid === ICCID);
      console.log(`   - Messages for ICCID ${ICCID}: ${messagesForPhone.length}`);
      
      if (messagesForPhone.length > 0) {
        console.log(`   - Sample messages:`);
        messagesForPhone.slice(0, 3).forEach((msg, i) => {
          console.log(`     ${i + 1}. ${msg.content?.substring(0, 50)}...`);
        });
      }
    }
  } catch (error) {
    console.error('   - Error:', error.message);
  }
  
  console.log('\n3. Testing AI insights endpoint:');
  try {
    const response = await fetch(`http://localhost:8787/api/ai/insights/${ICCID}`, {
      headers: {
        'Authorization': 'Bearer anonymous'
      }
    });
    
    const data = await response.json();
    console.log(`   - Response status: ${response.status}`);
    console.log(`   - Success: ${data.success}`);
    if (data.data && data.data.stats) {
      console.log(`   - Total messages (AI count): ${data.data.stats.total_messages}`);
      console.log(`   - Received: ${data.data.stats.received}`);
      console.log(`   - Sent: ${data.data.stats.sent}`);
    }
  } catch (error) {
    console.error('   - Error:', error.message);
  }
}

// Run the test
testMessageCount().catch(console.error);