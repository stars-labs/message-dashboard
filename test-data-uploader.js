#!/usr/bin/env node

const API_URL = 'https://sexy.qzz.io';
const API_KEY = '4025b019988238528f1fd5e909d0363c46e4e48490ea5045a9a490c259071cba';

// Sample phone data with ICCID and signal info
const samplePhones = [
  {
    id: 'SIM_0',
    number: '+86-138-0013-8000',
    country: 'CN',
    flag: '🇨🇳',
    carrier: 'China Mobile',
    status: 'active',
    signal: 85,
    iccid: '8986061900000123456F',
    rssi: -65.2,
    rsrq: -8.5,
    rsrp: -92.1,
    snr: 12.3
  },
  {
    id: 'SIM_1', 
    number: '+86-139-0013-9000',
    country: 'CN',
    flag: '🇨🇳',
    carrier: 'China Unicom',
    status: 'active',
    signal: 72,
    iccid: '8986061800000654321F',
    rssi: -72.8,
    rsrq: -9.2,
    rsrp: -98.4,
    snr: 8.7
  },
  {
    id: 'SIM_2',
    number: '+852-9876-5432',
    country: 'HK', 
    flag: '🇭🇰',
    carrier: 'CSL Mobile',
    status: 'active',
    signal: 90,
    iccid: '8985200012345678901F',
    rssi: -58.3,
    rsrq: -7.1,
    rsrp: -85.6,
    snr: 15.2
  },
  {
    id: 'SIM_3',
    number: '+65-8888-9999',
    country: 'SG',
    flag: '🇸🇬', 
    carrier: 'Singtel',
    status: 'active',
    signal: 68,
    iccid: '8965040012345678902F',
    rssi: -75.1,
    rsrq: -10.8,
    rsrp: -102.3,
    snr: 6.4
  },
  {
    id: 'SIM_4',
    number: '+1-555-123-4567',
    country: 'US',
    flag: '🇺🇸',
    carrier: 'Verizon',
    status: 'active', 
    signal: 78,
    iccid: '8901260123456789012F',
    rssi: -68.9,
    rsrq: -8.9,
    rsrp: -95.7,
    snr: 10.1
  }
];

// Sample messages
const sampleMessages = [
  {
    id: 'msg-001',
    phone_id: 'SIM_0',
    phone_number: '+86-10000',
    content: '【验证码】您的验证码是：123456，请在5分钟内使用。',
    source: 'China Mobile',
    timestamp: new Date().toISOString(),
    type: 'received'
  },
  {
    id: 'msg-002', 
    phone_id: 'SIM_1',
    phone_number: '+86-10010',
    content: '【通知】您的话费余额为58.32元，建议及时充值。',
    source: 'China Unicom',
    timestamp: new Date(Date.now() - 300000).toISOString(), // 5 minutes ago
    type: 'received'
  },
  {
    id: 'msg-003',
    phone_id: 'SIM_2', 
    phone_number: '+852-1234',
    content: 'Your verification code is 789012. Valid for 10 minutes.',
    source: 'HK Service',
    timestamp: new Date(Date.now() - 600000).toISOString(), // 10 minutes ago
    type: 'received'
  }
];

async function uploadData() {
  console.log('Uploading sample data to SMS dashboard...');
  
  try {
    // Update phones
    console.log('Updating phone data...');
    const phoneResponse = await fetch(`${API_URL}/api/control/phones`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-API-Key': API_KEY
      },
      body: JSON.stringify({ phones: samplePhones })
    });
    
    if (phoneResponse.ok) {
      const phoneResult = await phoneResponse.json();
      console.log('✅ Phone data updated:', phoneResult);
    } else {
      console.log('❌ Failed to update phones:', phoneResponse.status, await phoneResponse.text());
    }
    
    // Upload messages
    console.log('Uploading sample messages...');
    const messageResponse = await fetch(`${API_URL}/api/control/messages`, {
      method: 'POST', 
      headers: {
        'Content-Type': 'application/json',
        'X-API-Key': API_KEY
      },
      body: JSON.stringify({ messages: sampleMessages })
    });
    
    if (messageResponse.ok) {
      const messageResult = await messageResponse.json();
      console.log('✅ Messages uploaded:', messageResult);
    } else {
      console.log('❌ Failed to upload messages:', messageResponse.status, await messageResponse.text());
    }
    
  } catch (error) {
    console.error('❌ Error uploading data:', error);
  }
}

if (require.main === module) {
  uploadData();
}