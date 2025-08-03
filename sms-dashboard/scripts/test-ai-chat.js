const AUTH_TOKEN = process.env.AUTH_TOKEN;
const API_URL = 'https://sexy.qzz.io/api/ai/chat';

async function testChat() {
  if (!AUTH_TOKEN) {
    console.error('Please set AUTH_TOKEN environment variable');
    process.exit(1);
  }

  const testMessage = "Which phones are online?";
  console.log(`Testing chat with message: "${testMessage}"`);

  try {
    const response = await fetch(API_URL, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${AUTH_TOKEN}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        message: testMessage,
        conversation_id: null
      })
    });

    const data = await response.json();
    console.log('Response status:', response.status);
    console.log('Response data:', JSON.stringify(data, null, 2));
  } catch (error) {
    console.error('Error:', error);
  }
}

testChat();