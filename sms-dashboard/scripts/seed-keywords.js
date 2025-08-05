// Script to seed test keywords directly via control API

const API_KEY = process.env.API_KEY || 'test-api-key';
const API_URL = process.env.API_URL || 'https://sexy.qzz.io';

// Test keywords to seed
const testKeywords = [
  // Authentication keywords
  { keyword: 'verification', tag: 'AUTH', color: '#3B82F6', priority: 10, case_sensitive: false, whole_word: false },
  { keyword: 'code', tag: 'CODE', color: '#10B981', priority: 9, case_sensitive: false, whole_word: true },
  { keyword: 'OTP', tag: 'OTP', color: '#8B5CF6', priority: 10, case_sensitive: true, whole_word: true },
  { keyword: 'password', tag: 'PWD', color: '#EF4444', priority: 8, case_sensitive: false, whole_word: true },
  
  // Financial keywords  
  { keyword: 'payment', tag: 'PAY', color: '#F59E0B', priority: 7, case_sensitive: false, whole_word: true },
  { keyword: 'transaction', tag: 'TXN', color: '#F97316', priority: 7, case_sensitive: false, whole_word: true },
  { keyword: 'balance', tag: 'BAL', color: '#06B6D4', priority: 6, case_sensitive: false, whole_word: true },
  
  // Alert keywords
  { keyword: 'URGENT', tag: 'ALERT', color: '#DC2626', priority: 10, case_sensitive: true, whole_word: true },
  { keyword: 'warning', tag: 'WARN', color: '#F59E0B', priority: 8, case_sensitive: false, whole_word: true },
  { keyword: 'alert', tag: 'ALERT', color: '#EF4444', priority: 8, case_sensitive: false, whole_word: true },
  
  // Spam/Marketing
  { keyword: 'unsubscribe', tag: 'SPAM', color: '#6B7280', priority: 5, case_sensitive: false, whole_word: true },
  { keyword: 'promo', tag: 'AD', color: '#9CA3AF', priority: 4, case_sensitive: false, whole_word: true },
  { keyword: 'offer', tag: 'AD', color: '#9CA3AF', priority: 4, case_sensitive: false, whole_word: true }
];

async function seedKeywords() {
  console.log('🌱 Seeding keywords for testing...\n');
  
  // Note: Since we don't have a direct endpoint to create keywords via control API,
  // we'll document the keywords that should be added via the UI
  
  console.log('Please add the following keywords via the Keywords tab in the UI:\n');
  
  testKeywords.forEach((kw, index) => {
    console.log(`${index + 1}. Keyword: "${kw.keyword}"`);
    console.log(`   Tag: ${kw.tag}`);
    console.log(`   Color: ${kw.color}`);
    console.log(`   Priority: ${kw.priority}`);
    console.log(`   Case Sensitive: ${kw.case_sensitive}`);
    console.log(`   Whole Word: ${kw.whole_word}`);
    console.log('');
  });
  
  console.log('\nAfter adding these keywords, messages containing these terms will be automatically highlighted with their respective tags and colors.');
  
  // Test message upload to verify keyword processing
  console.log('\n📨 Uploading test messages to verify keyword processing...\n');
  
  const testMessages = [
    {
      phone_iccid: '89860117801716597135',
      phone_number: '+8613800138000',
      content: 'Your verification code is 123456. Please use this code to complete your login.',
      timestamp: new Date().toISOString(),
      sms_id: `test-${Date.now()}-1`
    },
    {
      phone_iccid: '89860117801716597135',
      phone_number: '+8613800138000',
      content: 'URGENT: Your payment of $100 failed. Transaction declined. Check your balance.',
      timestamp: new Date().toISOString(),
      sms_id: `test-${Date.now()}-2`
    },
    {
      phone_iccid: '89860117801716597135',
      phone_number: '+8613800138000',
      content: 'Special promo offer! Get 50% off today only. Reply STOP to unsubscribe.',
      timestamp: new Date().toISOString(),
      sms_id: `test-${Date.now()}-3`
    }
  ];
  
  try {
    const response = await fetch(`${API_URL}/api/control/messages`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-API-Key': API_KEY
      },
      body: JSON.stringify({ messages: testMessages })
    });
    
    const result = await response.json();
    
    if (result.success) {
      console.log('✅ Test messages uploaded successfully!');
      console.log(`   Processed: ${result.processed} messages`);
      console.log(`   Duplicates: ${result.duplicates} messages`);
      console.log('\n🎉 Keywords should now be highlighted in these messages!');
    } else {
      console.error('❌ Failed to upload messages:', result.error);
    }
  } catch (error) {
    console.error('❌ Error uploading test messages:', error);
  }
}

// Run the seeding
seedKeywords();