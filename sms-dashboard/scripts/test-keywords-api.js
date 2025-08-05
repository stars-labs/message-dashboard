import 'dotenv/config';

const API_KEY = process.env.API_KEY || 'test-api-key';
const API_URL = process.env.API_URL || 'https://sexy.qzz.io';

async function testKeywordProcessing() {
  console.log('Testing keyword processing on uploaded messages...\n');
  
  // Test message with multiple potential keyword matches
  const testMessages = [
    {
      phone_iccid: '89860117801716597135',
      phone_number: '+8613800138000',
      content: 'Your verification code is 123456. Please enter it within 5 minutes.',
      timestamp: new Date().toISOString(),
      sms_id: 'test-sms-1'
    },
    {
      phone_iccid: '89860117801716597135', 
      phone_number: '+8613800138000',
      content: 'Payment of $99.99 completed. Transaction ID: TRX123456. Thank you!',
      timestamp: new Date().toISOString(),
      sms_id: 'test-sms-2'
    },
    {
      phone_iccid: '89860117801716597135',
      phone_number: '+8613800138000', 
      content: 'URGENT: Your account password will expire in 24 hours. Please update it.',
      timestamp: new Date().toISOString(),
      sms_id: 'test-sms-3'
    }
  ];
  
  try {
    // Upload test messages
    const response = await fetch(`${API_URL}/api/control/messages`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-API-Key': API_KEY
      },
      body: JSON.stringify({ messages: testMessages })
    });
    
    const result = await response.json();
    console.log('Upload result:', result);
    
    if (result.success) {
      console.log('\n✅ Test messages uploaded successfully!');
      console.log('Messages should now be highlighted with keywords in the dashboard.');
      console.log('\nExpected highlights:');
      console.log('- Message 1: "verification", "code" should be highlighted');
      console.log('- Message 2: "Payment", "Transaction" should be highlighted');  
      console.log('- Message 3: "URGENT", "password" should be highlighted');
    } else {
      console.error('❌ Failed to upload test messages:', result.error);
    }
  } catch (error) {
    console.error('❌ Error testing keyword processing:', error);
  }
}

// Run the test
testKeywordProcessing();