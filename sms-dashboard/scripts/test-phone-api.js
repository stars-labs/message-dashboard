#!/usr/bin/env node

const API_URL = 'https://sexy.qzz.io';
const AUTH_TOKEN = process.env.AUTH_TOKEN || 'YOUR_AUTH_TOKEN_HERE';

async function testPhoneAPI() {
  if (!AUTH_TOKEN || AUTH_TOKEN === 'YOUR_AUTH_TOKEN_HERE') {
    console.error('Please set AUTH_TOKEN environment variable');
    console.error('Get it from browser DevTools: Application > Local Storage > auth_token');
    process.exit(1);
  }

  try {
    console.log('Fetching phones from API...');
    
    const response = await fetch(`${API_URL}/api/phones`, {
      headers: {
        'Authorization': `Bearer ${AUTH_TOKEN}`,
        'Content-Type': 'application/json'
      }
    });

    console.log('Response status:', response.status);
    const result = await response.json();
    
    if (response.ok && result.success) {
      console.log('✅ Successfully retrieved phones');
      
      // Find the phone with ICCID ending in 937419
      const targetPhone = result.data.find(phone => phone.iccid && phone.iccid.endsWith('937419'));
      
      if (targetPhone) {
        console.log('\nTarget phone found:');
        console.log('ICCID:', targetPhone.iccid);
        console.log('Number:', targetPhone.number);
        console.log('Mapped Number:', targetPhone.mapped_number);
        console.log('Mapped Carrier:', targetPhone.mapped_carrier);
        console.log('Full record:', JSON.stringify(targetPhone, null, 2));
      } else {
        console.log('Phone with ICCID ending in 937419 not found');
        console.log('All phones:', result.data.map(p => ({ iccid: p.iccid, number: p.number })));
      }
    } else {
      console.error('❌ Failed to fetch phones:', result);
    }
  } catch (error) {
    console.error('Error:', error);
  }
}

testPhoneAPI();