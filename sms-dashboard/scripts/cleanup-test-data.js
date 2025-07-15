// Script to clean up test/duplicate data from the database
const API_URL = 'https://sexy.qzz.io';
const API_KEY = '4025b019988238528f1fd5e909d0363c46e4e48490ea5045a9a490c259071cba';

async function cleanupTestData() {
  console.log('Cleaning up test data from database...');
  
  // List of test phone IDs to remove
  const testPhoneIds = [
    'SIM_0', 'SIM_1', 'SIM_2', 'SIM_3', 'SIM_4',
    'SIM_TEST', 'SIM_TEST2',
    'SIM_DEBUG'
  ];
  
  try {
    // Create a custom endpoint to clean up test data
    const response = await fetch(`${API_URL}/api/control/cleanup-test-data`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-API-Key': API_KEY
      },
      body: JSON.stringify({
        phoneIds: testPhoneIds
      })
    });
    
    if (!response.ok) {
      throw new Error(`HTTP error! status: ${response.status}`);
    }
    
    const result = await response.json();
    console.log('Cleanup result:', result);
  } catch (error) {
    console.error('Error cleaning up test data:', error);
  }
}

cleanupTestData();