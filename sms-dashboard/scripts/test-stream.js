const AUTH_TOKEN = process.env.AUTH_TOKEN;
const API_URL = 'https://sexy.qzz.io/api/ai/chat/stream';

async function testChatStream() {
  if (!AUTH_TOKEN) {
    console.error('Please set AUTH_TOKEN environment variable');
    process.exit(1);
  }

  const testMessage = "What are my messaging statistics for today?";
  console.log(`Testing streaming chat with message: "${testMessage}"`);

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

    console.log('Response status:', response.status);
    console.log('Response headers:', Object.fromEntries(response.headers.entries()));

    if (!response.ok) {
      const errorText = await response.text();
      console.error('Error response:', errorText);
      return;
    }

    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';

    console.log('\n--- Streaming Response ---');
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split('\n');
      buffer = lines.pop() || '';

      for (const line of lines) {
        if (line.trim()) {
          console.log('Line:', line);
        }
      }
    }
    console.log('--- End of Stream ---');

  } catch (error) {
    console.error('Error:', error);
  }
}

testChatStream();