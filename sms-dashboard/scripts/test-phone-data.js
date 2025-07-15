#!/usr/bin/env node

// Node.js 20+ has built-in fetch

const API_URL = 'https://sexy.qzz.io';
const API_KEY = '4025b019988238528f1fd5e909d0363c46e4e48490ea5045a9a490c259071cba';

const testPhones = [
  {
    iccid: '89860040191833946266',
    number: '6590950236',
    country: 'SG',
    flag: '🇸🇬',
    carrier: 'Singtel',
    status: 'online',
    signal: 85,
    rssi: -65,
    rsrq: -10,
    rsrp: -95,
    snr: 15,
    operator_name: 'Singtel',
    operator_id: '52501',
    imei: '357043090123456',
    access_tech: 'lte'
  },
  {
    iccid: '89860040191833946267',
    number: null,
    country: 'SG',
    flag: '🇸🇬', 
    carrier: 'M1',
    status: 'online',
    signal: 75,
    rssi: -72,
    rsrq: -12,
    rsrp: -98,
    snr: 12,
    operator_name: 'M1',
    operator_id: '52503',
    imei: '357043090123457',
    access_tech: 'lte'
  },
  {
    iccid: '89860040191833946268',
    number: '6591234567',
    country: 'SG',
    flag: '🇸🇬',
    carrier: 'StarHub',
    status: 'online',
    signal: 90,
    rssi: -60,
    rsrq: -8,
    rsrp: -90,
    snr: 18,
    operator_name: 'StarHub',
    operator_id: '52505',
    imei: '357043090123458',
    access_tech: 'lte'
  }
];

async function updatePhones() {
  try {
    const response = await fetch(`${API_URL}/api/control/phones`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-API-Key': API_KEY
      },
      body: JSON.stringify({ phones: testPhones })
    });

    const result = await response.json();
    console.log('Response:', result);
    
    if (response.ok) {
      console.log('✅ Successfully updated test phones');
    } else {
      console.error('❌ Failed to update phones:', result);
    }
  } catch (error) {
    console.error('Error:', error);
  }
}

updatePhones();